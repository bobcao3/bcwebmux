# Authentication

The browser surface is closed as soon as one authentication factor is enrolled,
and it works at every address the server answers on.

- **Authenticator app (baseline).** A TOTP secret is enrolled from the host and
  turned into six-digit codes by Google Authenticator, 1Password, Aegis, or any
  other RFC 6238 app.
- **Security keys (optional).** One or more WebAuthn credentials are enrolled
  from **Settings → SECURITY** in the browser, one per device, once a session
  exists. WebAuthn's origin rules mean a key only works at a domain-named
  origin, which is why it is the secondary factor rather than the baseline.

Configuration keys and CLI usage live in the
[application README](../app-bcwebmux/README.md).

## Threat model

The service runs shells, so anything that can obtain a browser session is
already a shell on the host. Enrolling a factor raises that step from "reach the
port" to "hold the shared secret" or "hold the key".

- **In scope:** an unauthenticated attacker who can reach the listener, a stolen
  session cookie, a replayed or guessed code, cross-origin abuse of the sign-in
  endpoints, and lockout as a denial of service.
- **Out of scope by design:** host access. Anyone who can read or write the
  state file can reset authentication, exactly like anyone who can edit
  `authorized_keys` can change who may log in.
- **Not attempted:** multi-user accounts, passwords, and per-address policy.

## The authenticator app (baseline)

### Enrollment

```sh
bcwebmux-server auth totp                 # enroll, printing a scannable QR code
bcwebmux-server auth totp --no-qr         # print the URI and secret instead
bcwebmux-server auth totp --rotate        # replace an existing secret
bcwebmux-server auth totp --account NAME  # label shown inside the app
```

Everything happens over the terminal, so no port, page, or browser is involved
and the service can keep running:

1. A 160-bit secret is generated and printed as an `otpauth://` URI, both as a
   scannable QR code and as text.
2. The command asks for the code the app now shows.
3. Only a matching code is stored. A mistyped secret, a wrong scan, or a
   terminal that mangled the QR therefore cannot lock anyone out, and a run that
   is interrupted changes nothing.

The stored factor is SHA-1, six digits, 30-second steps, which is what every
authenticator app assumes by default.

### Sign-in

The login page shows a code field:

- Codes are accepted for the current time step and its two neighbours, one step
  of drift either way.
- **A code is single use.** The accepted time step is recorded, and a code for a
  step that was already used is refused, so a sniffed code cannot be replayed
  inside its 30-second window even though it still matches.
- **Repeated failures back off.** After five rejected codes the server answers
  `429` with `Retry-After`, and the wait doubles up to 15 minutes. Six digits in
  a three-step window are guessable given unlimited attempts, so the limiter is
  load bearing; the cap keeps a remote attacker from locking the operator out
  for long. The counter lives in memory and resets on a successful sign-in or
  after an hour without failures.
- Every rejected, replayed, and rate-limited attempt is logged with the origin
  and remote address. The submitted code is never logged.

### Reset

```sh
bcwebmux-server auth list                 # factors, enrolment dates, last use
bcwebmux-server auth remove --totp        # drop the app
bcwebmux-server auth remove --all         # drop every factor
```

Removing the last factor deletes the session signing key with it, so every
issued session dies at once, and the running service re-reads the file within a
second — no restart. Deleting the state file does the same thing. Rotating the
secret with `--rotate` is not a reset: sessions issued before the rotation stay
valid until they expire, so revoke them with `auth remove --totp` when the old
secret may have leaked.

## Security keys (optional)

Keys are enrolled from the browser, because that is where the key is: a FIDO2
ceremony needs the device in the operator's hand, not a shell on the host. The
CLI never enrolls one.

**Settings → SECURITY** lists every factor and manages the keys:

- Enroll one key per device and name it after the device — `macbook · touch id`
  and `pixel · fingerprint` are two entries, and either signs in on its own.
- Enrolling and removing are the only operations, and both require a fresh
  factor first: an assertion from a key that is already enrolled, or a current
  code from the authenticator app. A stolen session cookie alone can do neither,
  and the arming lasts five minutes.
- The code path is what makes the first key possible: a session that signed in
  with the app holds no key of its own to assert.

Sign-in with a key is a normal WebAuthn assertion, and the resulting session is
bound to that credential: removing the key revokes its sessions immediately.
Registration and step-up both require user verification (PIN or biometric), so
the credential is bound to whoever can unlock that device.

The authenticator app itself stays a host operation: it is enrolled with
`bcwebmux-server auth totp`, and `bcwebmux-server auth list` / `auth remove`
remain the recovery path from a shell.

### Why keys are origin-bound

WebAuthn credentials are scoped to a relying party ID, which must be a domain,
and the browser verifies that the page's origin belongs to that domain. This is
what makes WebAuthn phishing resistant, and it is also why a key cannot be used
at an IP-literal address: Chromium rejects the ceremony before any key prompt,
and a Related Origin Requests document does not help because IP origins are
skipped by that mechanism.

So:

| Address                                | Authenticator app | Security key                           |
| -------------------------------------- | ----------------- | -------------------------------------- |
| `https://terminal.example.ts.net:8443` | works             | works, enrolled for that host          |
| `https://192.168.1.20:8443`            | works             | impossible: no relying party ID exists |

A ceremony needs a secure context, which is HTTPS or plain http on `localhost`,
and a hostname that can be a relying party ID. Usable origins are listed at
startup, and an origin that cannot host a ceremony is reported with the reason.
`localhost` can hold a key like any hostname once its certificate is trusted.

## Sessions

Both factors issue the same session cookie:

| Property | Value                                                                            |
| -------- | -------------------------------------------------------------------------------- |
| Name     | `bcwebmux_session`                                                               |
| Content  | base64url payload + HMAC-SHA256 signature                                        |
| Payload  | version, factor, relying party and credential (keys only), issued-at, expires-at |
| Flags    | `HttpOnly`, `SameSite=Strict`, `Path=/`, `Secure` for `https` origins            |
| Lifetime | `--auth-session-ttl`, default 168h, re-issued after half its lifetime            |

The signing key is a random 32-byte value in the state file. A session is
re-validated on every request: the signature, the expiry, and the presence of
the factor it was issued to must all hold, and sessions outlive a service
restart because that key is on disk. An authenticator-app session works at every
address the server answers on, because the browser scopes each cookie to the
host that issued it; a key session is additionally bound to the relying party it
was issued for.

## Guards and endpoints

With at least one factor enrolled, every origin requires a session:

| Request        | Unauthenticated result                 |
| -------------- | -------------------------------------- |
| `/api/...`     | `401` JSON with code `unauthenticated` |
| `/ws`          | `401` before the upgrade               |
| Any other path | `302` to `/login`                      |

The only responses served without a session are the login page and its assets,
plus the `/auth/*` endpoints themselves. Application HTML and assets are never
reachable unauthenticated.

Every POST requires the configured `Origin`, exactly like the session API.
WebAuthn challenges are held in memory, expire after five minutes, are single
use, and are bounded to 64 pending ceremonies.

Non-browser clients sign in the same way: post `{"code":"123456"}` to
`/auth/totp/verify` with the configured `Origin`, then send the returned session
cookie with every request.

## Storage

`$XDG_STATE_HOME/bcwebmux/auth.json` (`~/.local/state/bcwebmux/auth.json` by
default), mode 0600, holds the enrolled authenticator secret, the public keys,
and the session signing key. Writes are atomic and every change re-reads the
file under a sibling `<auth-file>.lock` file before writing, so a reset or
enrollment that races an in-flight sign-in wins. A file that cannot be parsed is
not treated as a reset: the running service keeps the last state it loaded and
logs the failure, while a restart with such a file refuses to start rather than
serving unauthenticated.

## Limits

- **Sessions are bearer tokens.** A browser that is already signed in stays
  signed in for up to the session lifetime without a new code.
- **Attestation is not verified.** The server requests `attestation: "none"`, so
  it cannot enforce a policy such as "hardware keys only".
- **The authenticator secret is a single factor.** Anyone who can read the state
  file, or the QR code during enrollment, can generate codes. Nothing else in
  the file is secret in the same way: public keys cannot sign.
- **No account recovery.** Losing the app and every key means losing browser
  access until someone with host access enrolls a factor again.
