# bcwebmux application

A browser terminal with persistent PTY sessions, multiple clients, and GPU
rendering. The Go HTTP(S)/WebSocket frontend connects to a Zig session daemon;
server and browser run the same pinned libghostty terminal. Clients reconnect
from snapshots.

## Build and run

First run: [repository quickstart](../README.md#run-it). Building needs Linux,
Zig 0.17.0, and Node/npm plus network access; the build embeds the web UI, and
any browser with WebGPU or WebGL2 uses it.

Before exposing the terminal remotely or reaching it from a phone, configure
trusted HTTPS and enroll a factor below, or use an authenticated TLS proxy. An
origin allowlist is **not authentication**. Phones use the browser install menu;
plain LAN HTTP is insufficient and the app needs a live server.

## Session daemon

Keep `bcwebmux-server`, `bcwebmux-sessiond`, and `bcwebmux-worker` in the same
directory. The web server connects to an existing daemon or starts the sibling
`bcwebmux-sessiond` detached when the socket is absent or refuses connections.
The detached daemon has no terminal or standard input/output and is not stopped
with the web server. For custom session options, start and supervise the daemon
yourself before starting the web server.

Restarting the web server disconnects browsers but leaves the daemon's sessions
and shells running. Browsers can reconnect and restore retained output. Stopping
the daemon ends its sessions. Existing sessions from the old single-process
server cannot be transferred to the daemon.

Both programs default to `/tmp/bcwebmux-UID/session.sock`, where `UID` is the
effective user ID. The daemon creates the directory with owner-only access. For
a different path, create a trusted directory owned by the same user and pass
`--socket PATH` to the daemon and `--session-socket PATH` to the web server. The
socket is private to that user; access to it permits control of sessions. Keep
its parent and ancestors protected from replacement.

Session options move to the daemon: `--shell`, `--worker`, `--term`,
`--max-sessions`, `--kitty-graphics true|false`, and `--webp-quality`. Remove
them from the web server's TOML or CLI. The web server stores drawer layout in
`$XDG_STATE_HOME/bcwebmux/metadata.json` and session names alongside it in
`metadata.json.names`. When `XDG_STATE_HOME` is unset, the directory is
`~/.local/state/bcwebmux`. Use `--metadata-file` to select another layout path;
the names file uses that path with `.names` appended. The daemon keeps an
in-memory copy of each name for session notifications; the web server's names
file is authoritative.

## Authentication

```sh
./zig-out/bin/bcwebmux-server auth totp
./zig-out/bin/bcwebmux-server auth list
./zig-out/bin/bcwebmux-server auth remove --id <id> # one key
./zig-out/bin/bcwebmux-server auth remove --totp    # app factor
```

Enroll from the server machine: scan the QR code and enter the shown code; the
service keeps running. Once a factor is enrolled, all browser addresses require
sign-in. TOTP works at IP literals; security keys need a hostname or trusted
localhost origin (Settings → SECURITY). Removing the last factor reopens the
service, so stop it or restrict access first. Use `--auth=false` only behind an
authenticated forwarder or for isolated tests/recovery
([authentication guide](../docs/authentication.md)).

### Authenticated forwarding with changing origins

When a trusted forwarder handles authentication and the browser-facing origin is
not known in advance:

```sh
./zig-out/bin/bcwebmux-server \
  --listen 127.0.0.1:8080 \
  --auth=false \
  --allow-any-origin
```

Forward to `http://127.0.0.1:8080`. The forwarder must authenticate every route
and WebSocket upgrade, support WebSockets, and prevent direct backend access.
Cookie-based forwarding also needs cross-site request protection.

`--allow-any-origin` bypasses Origin checks for WebSockets and mutating APIs; it
requires `--auth=false` and does not add CORS response headers. The TOML key is
`allow-any-origin = true`. Without this opt-in, exact origin checks remain
enabled.

## Server configuration

`--config FILE` selects a TOML file; otherwise the first of
`$XDG_CONFIG_HOME/bcwebmux/config.toml` (`~/.config/bcwebmux/` when unset) or
`$HOME/.bcwebmux.toml` wins, without merging. CLI overrides TOML; unknown keys
are fatal. `--help` lists keys.

```toml
listen = ["127.0.0.1:8443"]; origins = ["https://localhost:8443"]
tls-cert = "/path/to/fullchain.pem"; tls-key = "/path/to/key.pem"
```

`listen` takes `HOST:PORT`, `IP:PORT`, or `CIDR:PORT` sharing one port;
`origins` are exact scheme/host/port values. The TLS pair comes together and
origins must then be `https`. `http3 = true` adds HTTP/3 on the same port and
needs TLS plus UDP access. Report progress with OSC 7501 or OSC 9;4 codes; the
server keeps reports for reconnecting clients. Kitty images reach browsers
re-encoded as WebP; the daemon's `--webp-quality` tunes optional transcoding
while resolution clamping remains active
([Kitty graphics](../docs/kitty-graphics.md#webp-transcoding)).

## Development

Run from `app-bcwebmux/`:

```sh
zig build -Doptimize=small
zig build test && zig build gotest
node test/session-controller-contract.mjs
node test/session-autostart-integration.mjs ./zig-out/bin/bcwebmux-server
node test/session-daemon-restart.mjs ./zig-out/bin/bcwebmux-sessiond ./zig-out/bin/bcwebmux-server ./zig-out/web
node test/session-layout-sync-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web
```

Browser tests need Chromium, a physical Vulkan GPU, and Noto CJK fonts; without
them run only the first five commands above. Update goldens deliberately: rerun
the failing test with `UPDATE_GOLDEN=1`, inspect the images, then rerun
normally.
