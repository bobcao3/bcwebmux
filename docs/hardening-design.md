# Hardening proposals

Status: proposal. This document follows a review of the authentication surface
and the Zig session engine. The first section records what that review changed;
the rest designs the changes that need a decision before they are built.

## Already changed

- **Authenticator-app removal revokes its sessions for good.** The state file
  counts app generations (`totpGeneration`), and every token the app signs in
  carries the generation it was issued under. `auth remove --totp` and
  `auth totp --rotate` move the generation on, so a session cookie issued before
  the removal stays dead after the app is enrolled again, even when a security
  key kept the signing key alive. Security key sessions are untouched.
- **Sessions have an absolute lifetime.** Tokens carry their first sign-in time
  across renewals; `--auth-session-max-age` (default 720h, TOML
  `auth-session-max-age`) caps how far renewals can reach, and the last cookie
  before the cap is shortened to end exactly there.
- **A code step-up requires the app to still be enrolled**, not only a valid
  step-up cookie.
- **`GET /api/sessions` no longer renders into a fixed 64 KiB buffer.** Sixty
  four retained sessions with maximal escaped titles outgrew it and turned the
  listing into a `500` until retention expired.
- **The legacy standalone Zig HTTP server is gone** (`zig build legacy`,
  `src/server.zig`, the embedded asset archive and its tar/zstd pipeline). It
  had no authentication and was one build-script edit away from shipping.

## 1. Run the mirror terminal in the session worker

### Today

`app-bcwebmux/src/Session.zig` keeps a libghostty terminal (`mirror_terminal`,
`mirror_stream`) and a Kitty graphics adapter per session inside the server
process, the same process that terminates TLS, holds the authentication state
and owns every other session. Every byte a program prints is parsed there
(`acceptOutput`), and checkpoints are encoded from that state. The PTY itself
already lives in a separate `bcwebmux-worker` process per session.

Terminal output is attacker-controlled in the ordinary sense: a remote host the
operator sshes into from inside bcwebmux, or a hostile file that gets `cat`ed,
chooses it. A memory-safety bug in the parser is therefore code execution in
the server, and a crash takes down every session at once. Moving the parser out
does not create a privilege boundary by itself, because the worker runs as the
same user, but it contains a crash to one session and takes the most complex
untrusted-input parser out of the process that matters most.

### Proposal

Move `mirror_terminal`, `mirror_stream`, the graphics adapter and checkpoint
encoding into the worker. The server keeps everything it needs for the wire
protocol: the raw output journal, event sequencing, attachments, leases, replay
and the checkpoint bytes it hands to clients. Only where those bytes come from
changes.

Worker protocol additions (`session_worker.zig`, one-byte kind prefix, packets
of at most 64 KiB as today):

| Direction       | Kind                 | Payload                                                          |
| --------------- | -------------------- | ---------------------------------------------------------------- |
| server → worker | `checkpoint_request` | request id (u64)                                                 |
| worker → server | `checkpoint_begin`   | request id, total bytes (u32), SHA-256, output bytes at capture  |
| worker → server | `checkpoint_chunk`   | request id, offset (u32), bytes                                  |
| worker → server | `checkpoint_end`     | request id, status (ok, deferred, too large)                     |
| worker → server | `title`              | UTF-8 title, at most 256 bytes                                   |
| worker → server | `program_status`     | encoded `ProgramStatus.Report`                                   |
| worker → server | `progress_report`    | encoded `ProgressReport`, empty to clear                         |

- **Output stays the authority on offsets.** The worker counts the output bytes
  it has sent and only captures between packets, so a checkpoint's "output
  bytes at capture" always equals the server's `output_offset` after some
  journaled event. The server finds that event and records
  `checkpoint_event_seq` as now; if it cannot (a packet was lost to a failed
  session) it discards the checkpoint and marks the session failed, which is
  what happens today when the mirror diverges.
- **Capture timing** moves with the data: the worker captures when it has sent
  `checkpoint_output_bytes` since the last one or `checkpoint_interval_ms`
  elapsed, and additionally on request. The server still requests one on exit
  and when the journal is full, and treats `deferred` exactly like
  `error.CaptureDeferred` now.
- **Auto-replies** (`effectWritePty`: device attributes, XTVERSION, ENQ, size
  reports, OSC 7501 probes) are written by the worker straight into the PTY it
  already owns. They leave the server entirely; it no longer needs the
  `mirror_reply_failed` path.
- **Resize** stays as it is: the worker applies `TIOCSWINSZ`, and now also
  resizes its terminal before acknowledging, so the acknowledgement already
  reflects the mirror.
- **Metadata events** (`title`, `program_status`, `progress_report`) replace the
  handler effects that mutate `Session` fields today; the server applies them
  under `session.mutex` and bumps the revision the same way.
- **Failure isolation.** A worker that aborts in the parser closes the
  seqpacket channel, which the server already reports as `WorkerClosed` and
  turns into a failed session with its exit status recorded.

### Cost and sequencing

- Memory per session is unchanged in total; it moves from the server to the
  worker. Startup of a session gains the terminal initialisation it already
  pays today.
- Checkpoint latency gains one request/response over the socketpair, at most a
  few milliseconds for a 16 MiB checkpoint streamed in 64 KiB packets.
- The worker becomes a real Zig program linking libghostty-vt, zstd and the
  graphics adapter instead of a thin forkpty shim, so its build target grows.
- Order of work: (1) add the protocol kinds and a worker-side terminal behind a
  flag, with the server ignoring the new kinds; (2) switch checkpoint sourcing
  and metadata to the worker and delete the server mirror; (3) optionally
  confine the worker's parser further, for example by splitting the PTY owner
  and the parser into two processes so the parser can run under seccomp with
  no file descriptors beyond its two pipes. Step (3) is what turns isolation
  into a privilege boundary; steps (1) and (2) are worth doing without it.

## 2. Trim the unauthenticated status endpoint

### Today

`GET /auth/session` answers without a session and reports whether the
authenticator app is enrolled (`totp`), how many security keys cover this
origin (`enrolled`), the relying party ID, and a human-readable `reason`. The
login page uses these to decide which form to show. An attacker learns the same
things before any attempt, including that a given origin has no key and only
the code path to guess at.

### Proposal

Make the unauthenticated answer independent of the enrolled state:

```json
{ "authenticated": false, "required": true, "disabled": false,
  "origin": true, "secure": true, "stepUp": false }
```

- `required` stays, because an open server must bounce the login page back to
  the application. `origin` and `secure` derive from the request host, not
  from the state file, and are what the page needs to know whether a WebAuthn
  ceremony is possible at this address.
- `totp`, `enrolled`, `rpId` and `reason` leave the unauthenticated response.
  They remain in `GET /auth/credentials`, which already requires a session.
- The login page shows the code field and the security key button whenever
  `required` is true and `origin` is true (code field only otherwise). The
  relying party ID is not needed up front: the assertion options returned by
  `/auth/login/begin` carry it.
- Refusals stop distinguishing "not enrolled" from "wrong": a code posted
  while no app is enrolled is `401 invalid_code` and counts against the
  limiter, and `/auth/login/begin` at an origin without a key returns the same
  `401 authentication_failed` a bad assertion would, after the normal
  challenge accounting. The specific guidance ("sign in with the app and add a
  key in Settings → SECURITY") moves to the authenticated Settings panel,
  where the operator actually fixes it.
- Tests to update: `auth_totp_test.go` asserts `status["totp"]` at an IP
  origin; `login.js` branches on `session.totp` and `session.enrolled`.

What this does not hide: that authentication is required at all, and that the
server is bcwebmux. Both are visible from the login page itself.

## 3. Replace the global sign-in limiter

### Today

Five rejected codes from anyone lock the code path for everyone, doubling to
15 minutes. That bounds brute force (about twelve guesses an hour against a
three-step window of a million codes) at the price of letting any unauthenticated
client keep the operator out indefinitely with a trickle of bad codes. Security
key sign-in is unaffected, which is the only current escape.

### Proposal

Two tiers plus an operator escape hatch, all in memory:

1. **Per-source limiter.** Key failures by a hash of the remote address (the
   connection's, not a forwarded header, unless a `trusted-proxies` list is
   configured and the request arrived from one, in which case the last
   untrusted hop in `X-Forwarded-For` is used). Keep the current schedule per
   key: five free failures, then 30 s doubling to 15 min, forgotten after an
   hour without failures. Store at most 1024 keys in an LRU; evicting a key
   resets its count, which only helps an attacker who already controls more
   than a thousand addresses, and the global tier covers that case.
2. **Global ceiling.** Count every rejected code regardless of source. While
   more than 60 failures landed in the last hour, apply the global lock as
   today. Sixty an hour is 1440 a day, an expected 230 days to guess a code
   against the three-step window, and a distributed attacker has to sustain it
   for that long; a single abusive source never reaches it because tier one
   stops it at about twelve an hour.
3. **Escape hatch.** `bcwebmux-server auth unlock` writes a `limiterReset`
   timestamp into the state file; the running service picks it up on its next
   refresh (within a second) and clears both tiers. The operator with shell
   access is the only one who can run it, which is the same trust level that
   can already reset authentication. Restarting the service keeps working as
   it does now.
4. **Observability.** Log once when the global tier engages, with the number
   of distinct sources and the top three by failures, and once when it
   releases, instead of one line per rejected attempt during a lock.

Rejected alternatives: proof-of-work or CAPTCHA on the code form adds client
complexity for a single-operator service; a longer code window or more digits
changes what every authenticator app shows; persisting the limiter to disk
would make every rejected code a write to the state file.

### Interaction with the other factors

Security keys stay exempt from both tiers, as now. Step-up with a code
(`/auth/stepup/totp`) shares the limiter with sign-in because it consumes the
same codes; a locked limiter therefore also blocks enrolling a key with a code,
which is acceptable because that operation requires an existing session and
can wait.
