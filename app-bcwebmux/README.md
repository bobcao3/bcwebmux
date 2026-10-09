# bcwebmux application

A browser terminal with persistent PTY sessions, multiple
clients, and GPU rendering. The Go HTTP(S)/WebSocket frontend
uses a native Zig session core; server and browser run the same
pinned libghostty terminal. Clients reconnect from snapshots.

## Build and run

First run: [repository quickstart](../README.md#run-it). Building
needs Linux, Zig 0.16.0, Node/npm, and GNU tar plus network
access; the build embeds the web UI, and any browser with WebGPU
or WebGL2 uses it.

Before exposing the terminal remotely or reaching it from a
phone, configure trusted HTTPS and enroll a factor below, or use
an authenticated TLS proxy. An origin allowlist is
**not authentication**. Phones use the browser install menu;
plain LAN HTTP is insufficient and the app needs a live server.

## Authentication

```sh
./zig-out/bin/bcwebmux-server auth totp
./zig-out/bin/bcwebmux-server auth list
./zig-out/bin/bcwebmux-server auth remove --id <id> # one key
./zig-out/bin/bcwebmux-server auth remove --totp    # app factor
```

Enroll from the server machine: scan the QR code and enter the
shown code; the service keeps running. Once a factor is enrolled,
all browser addresses require sign-in. TOTP works at IP literals;
security keys need a hostname or trusted localhost origin
(Settings → SECURITY). Removing the last factor reopens the
service, so stop it or restrict access first. `--auth=false` is
tests/recovery only ([authentication guide](../docs/authentication.md)).

## Server configuration

`--config FILE` selects a TOML file; otherwise the first of
`$XDG_CONFIG_HOME/bcwebmux/config.toml` (`~/.config/bcwebmux/`
when unset) or `$HOME/.bcwebmux.toml` wins, without merging.
CLI overrides TOML; unknown keys are fatal. `--help` lists keys.

```toml
listen = ["127.0.0.1:8443"]; origins = ["https://localhost:8443"]
tls-cert = "/path/to/fullchain.pem"; tls-key = "/path/to/key.pem"
```

`listen` takes `HOST:PORT`, `IP:PORT`, or `CIDR:PORT` sharing one
port; `origins` are exact scheme/host/port values. The TLS pair
comes together and origins must then be `https`. `http3 = true`
adds HTTP/3 on the same port and needs TLS plus UDP access.
Report progress with OSC 7501 or OSC 9;4 codes; the server keeps
reports for reconnecting clients.

## Development

Run from `app-bcwebmux/`:

```sh
zig build -Doptimize=ReleaseSmall
zig build test && zig build gotest
node test/session-controller-contract.mjs
node test/session-ui-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web
...and the other `test/*-e2e.mjs` with the same arguments.
```

Browser tests need Chromium, a physical Vulkan GPU, and Noto CJK
fonts; without them run only the first three commands above.
Update goldens deliberately: rerun the failing test with
`UPDATE_GOLDEN=1`, inspect the images, then rerun normally.
