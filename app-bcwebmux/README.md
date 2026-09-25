# bcwebmux application

The complete remote-terminal application: browser UI, session management, and a
Go HTTP(S)/WebSocket frontend backed by a native Zig session core and PTY
worker.

## Core design

bcwebmux replicates a PTY session between the server and multiple clients. The
server and every client run the same libghostty terminal. The transport uses
state snapshots as its baseline, with compressed PTY diffs layered on top to
keep the replicas synchronized.

## Get started

Prerequisites: Zig 0.16.0, Node/npm, GNU tar, Linux, and a modern Chromium
browser with WebGPU or WebGL2. Ghostty is a pinned dependency: `build.zig.zon`
fetches the `bobcao3/ghostty` fork branch `bcwebmux/wasm-kitty-graphics` (commit
`a21f94b`), carrying the WASM portability edits described in the
[graphics plan](../docs/kitty-graphics.md). No local checkout is needed, and the
build uses pinned dependencies but requires network access on a fresh checkout
to download Go modules (and the Zig and npm dependencies). `zig build`
provisions a pinned Go toolchain itself and defaults to musl; no system Go or C
toolchain is required.

```sh
# From the repository root
npm install
cd app-bcwebmux
zig build -Doptimize=ReleaseSmall
./zig-out/bin/bcwebmux-server
```

Open <http://localhost:8080>. Use `--help` for server options. Remote use needs
explicit host/origin options and either an enrolled FIDO2 security key (see
[Authentication](#authentication)) or authenticated TLS in front of the service.

To install on a phone, open the app on a **trusted HTTPS** origin (not plain
HTTP to a LAN IP or a certificate-warning bypass), sign in if required, then use
the browser's install/add-to-home-screen menu. The PWA service worker is
network-only: the terminal requires a live server and is not available offline.

## Authentication

The browser surface is closed as soon as one factor is enrolled, and it works at
every address the server answers on. The baseline is an authenticator app:

```sh
./zig-out/bin/bcwebmux-server auth totp          # prints a QR code, then asks
./zig-out/bin/bcwebmux-server auth list
./zig-out/bin/bcwebmux-server auth remove --totp # or --all
```

Scan the code with Google Authenticator, 1Password, Aegis, or any TOTP app, then
type the six-digit code it shows back into the command: only a code that matches
the new secret is stored, so a wrong scan or an interrupted run changes nothing
and the service can keep running while you enroll.

Every address then requires a sign-in, and `/login` presents a code field where
a replayed or repeated wrong code is refused rather than retried forever.
Sessions last `--auth-session-ttl` (default 168h) and survive a restart, so a
device you use regularly rarely asks again.

Security keys are an optional extra, enrolled from the browser:

```sh
./zig-out/bin/bcwebmux-server auth list          # factors, dates, last use
./zig-out/bin/bcwebmux-server auth remove --id <id>
```

WebAuthn scopes a credential to a domain, so a key works at hostnames, and at
`localhost` with a trusted certificate, but never at an IP-literal address —
which is why the app stays the way in at `https://192.168.1.20:8443`. Origins
that cannot hold a key are reported at startup. **Settings → SECURITY** is where
keys are enrolled and removed, one per device, once signed in; the ceremony has
to happen in the browser because that is where the key is. Every change asks for
a fresh factor first — an assertion from an enrolled key, or a code from the app
— so a stolen session cookie cannot add a key of its own.

Deleting the state file, `auth remove --totp`, or `auth remove --all` revokes
the sessions those factors issued and returns the service to its unauthenticated
state, which the running service picks up within a second. `--auth=false`
disables the requirement entirely (and logs a warning); it exists for tests and
for recovery when a factor set is unusable. See the
[authentication design](../docs/authentication.md) for the ceremony, stored
state, gate behaviour, and threat model.

## Server configuration

New terminal sessions run the configured shell with `-l` (login shell), starting
in `$HOME`, independently of the server's working directory. An unset or empty
`HOME` falls back to the current user's passwd home directory. The home path
must be absolute; if it cannot be resolved or entered, session startup fails
rather than using the server's directory. Shell startup files may subsequently
change the terminal's directory. Existing sessions are unaffected.

`--config FILE` selects a TOML file explicitly (missing or unreadable files are
fatal). Otherwise the server reads the **first existing** file, without merging:

1. `$XDG_CONFIG_HOME/app-bcwebmux/config.toml`, defaulting to
   `$HOME/.config/bcwebmux/config.toml`. For compatibility, the nonstandard
   `$XDG_HOME` is used only when `XDG_CONFIG_HOME` is unset.
2. `$HOME/.bcwebmux.toml`.

Malformed TOML, unknown keys, and unreadable discovered files are fatal;
`--help` does not read configuration. All scalar CLI options override the file,
including `--http3=false`. Paths in TOML are relative to the process working
directory; there is no shell or tilde expansion. Supported keys are shown below,
plus legacy `host` and `origin` (single strings), `web-root`, `shell`, `term`,
`kitty-graphics`, `worker`, `auth`, `auth-file`, and `auth-session-ttl`.

Example `~/.config/bcwebmux/config.toml` (replace addresses, origins, and TLS
paths with your own; omit any range not present on this machine):

```toml
listen = ["100.64.0.0/10", "192.168.1.0/24", "127.0.0.1"]
port = 8443
origins = ["https://terminal.example.ts.net:8443", "https://192.168.1.20:8443", "https://localhost:8443"]
tls-cert = "/path/to/fullchain.pem"
tls-key = "/path/to/key.pem"
http3 = true
max-sessions = 16
auth-session-ttl = "168h"
# auth = false
# auth-file = "/var/lib/bcwebmux/auth.json"
```

`auth = false` disables the authentication requirement. `auth-file` defaults to
`$XDG_STATE_HOME/bcwebmux/auth.json`, or `~/.local/state/bcwebmux/auth.json`
when `XDG_STATE_HOME` is unset; the file is created with mode 0600 and holds the
enrolled public keys plus the session signing key. `auth-session-ttl` accepts Go
duration strings and defaults to `168h`.

New shells default to `TERM=xterm-ghostty` with Kitty graphics advertised.
Override with `--term` / `term`, or opt out of the Kitty hint with
`--kitty-graphics=false` / `kitty-graphics = false`.

`listen` accepts hostnames, IP literals, or CIDRs, all on the shared `port`.
Repeat `--listen` to replace the entire file list. Explicit `--host` clears the
file list for legacy single-host use; if both CLI options appear, `--listen`
wins. CIDRs select **only assigned local addresses**, never a wildcard socket.
Overlapping ranges and duplicate resolved addresses are deduplicated; each
unmatched range is an error. DNS and interfaces are resolved at startup, not
watched: restart after address changes. All TCP and (when enabled) UDP/HTTP3
sockets must bind successfully or startup rolls them all back. Port zero chooses
one shared ephemeral port.

When neither `listen` nor legacy `host` is provided, hostnames in `origins` are
resolved at startup and all resolved IPv4/IPv6 addresses assigned locally are
bound and deduplicated. Wildcard or remote-only results are rejected, and
startup fails if any hostname has no locally assigned address. Without
`origins`, `listen`, or `host`, the default remains `127.0.0.1`. Explicit
`listen` or `host` overrides this automatic resolution, which is needed for
reverse proxies whose public hostname is not locally assigned. Automatic
resolution uses the configured port, not origin ports, and is startup-only;
restart after address changes. The exact origin allowlist is unchanged, and IP
aliases are not auto-trusted.

For example:

```toml
origins = ["https://terminal.example.ts.net:3443"]
port = 3443
# Configure tls-cert and tls-key as shown above.
```

Repeat `--origin` to replace the file allowlist. Origins are exact
browser-facing scheme/host/port values, not CIDRs or wildcards. Non-loopback
listeners require an explicit allowlist; loopback-only listeners derive local
origins if none is set. Every mutation and WebSocket upgrade still requires
exactly one allowed Origin; this does not enable permissive CORS or disable CSRF
checks. TLS certificates must cover the names/IPs browsers use. HTTP/3 requires
TLS and UDP access on the same port as HTTPS. Origins are **not authentication**
on their own: until `auth totp` has run, restrict access with tailnet/firewall
policies or an authenticated TLS proxy. All listeners share one session engine
and assets. The startup log lists every bound address, accepted origin, and the
enrolled factors.

## Develop

From `app-bcwebmux/`:

```sh
zig build
zig build test                      # Zig tests only
zig build gotest                    # Go tests using the pinned toolchain and zig cc
zig build gotest -Dtarget=aarch64-linux-musl  # compile Go tests for another target
node --test test/network-relay.test.mjs test/network-recovery.test.mjs
node test/visual-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web
node test/auth-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web
node test/auth-totp-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web
```

`zig build test` uses Zig's test runner only. `gotest` uses Go's test runner;
for a nonnative target, it compiles tests instead of trying to run them.
JavaScript and browser tests run under Node, outside `build.zig`, after
`zig build` installs the server and web assets. Browser runs require Chromium
and a physical Vulkan GPU (no SwiftShader/llvmpipe). See the
[graphics integration plan](../docs/kitty-graphics.md). The shell startup
regression (requires `/bin/bash`) can also run directly:
`node test/session-shell-integration.mjs ./zig-out/bin/bcwebmux-server`. Use
`TEXT_RENDERER=canvas` with browser tests to exercise browser-canvas text; omit
it for kb/STB. Test server launches ignore personal server configuration and
personal authentication state. `test/auth-e2e.mjs` drives the factor lifecycle
(CLI enrollment of the app, code sign-in, per-device key enrollment from the
settings panel, key sign-in, removal) through Chromium's virtual authenticator,
and `test/auth-totp-e2e.mjs` drives the authenticator-app flow from an
IP-literal origin; neither needs a real key and neither touches the machine's
real `auth.json`.

### Glyph texture inspector

Settings → **PERF → VIEW GLYPH TEXTURE** opens a snapshot of the shared glyph
atlas on either GPU backend. Use **REFRESH** to capture again or **Actual
pixels** for an unscaled, scrollable view. The grayscale image shows the R8
alpha mask, including unused/stale cache slots, not a second rendering of the
terminal. Debug captures are limited to 16 Mi pixels and run only on request.

### Full-screen visual regression tests

After `zig build`, run `node --test test/visual-compare.test.mjs` and
`node test/visual-e2e.mjs ./zig-out/bin/bcwebmux-server ./zig-out/web`. Both
WebGPU and WebGL2 are tested at fixed viewport sizes:

| Device         | CSS viewport | DPR | Screenshot pixels |
| -------------- | ------------ | --- | ----------------- |
| Desktop        | 1440 × 900   | 1   | 1440 × 900        |
| Mobile (touch) | 390 × 844    | 3   | 1170 × 2532       |

Each captures the **entire viewport**, including terminal, telemetry, scrollbar,
and bottom controls. Cases cover UTF-8 (CJK, combining accents, Greek/Cyrillic),
emoji, ANSI styles/box drawing, and numbered `test/snapshot-fixture.zig` source.
Scrollback cases capture the bottom, Home/top, and PageDown/middle; End must
restore the original bottom image. Source is sent through the real shell/PTY.
The `kitty-graphics` case sends a four-color RGBA Kitty image through the PTY
and compares the full viewport against goldens on both backends and devices. The
Unicode preview uses browser `canvas`; source/scrollback uses the default
`kb-stb`, covering both text paths. Canvas uses the CSS/system font stack for
CJK and emoji fallback. The test observes actual terminal `fillText` calls and
checks nonblank alpha that differs from missing-glyph boxes, including combining
marks, variation selectors, skin tones, flags and ZWJ sequences, before
comparing screenshots. `*-font-probe.json` records that evidence. The shipped
Noto Emoji web font and installed Noto CJK fonts provide this test environment's
fallback coverage; install those CJK fonts for reproducible baselines. Color
emoji RGB remains outside the alpha-only atlas contract. kb/STB still depends on
the supplied TTF coverage. See the
[font contract](../wgpuTerminal/README.md#text-paths-and-fonts).

The Fira Code menu option uses an installed/browser-provided font and selects
Canvas automatically. If Fira Code is unavailable, its configured fallback stack
is used; the option does not add an external font download.

- Baselines: `test/golden/{desktop,mobile}-{webgpu,webgl2}-*.webp`.
- Actual PNGs and renderer-state JSON: `zig-out/screenshots/` (override with
  `BCWEBMUX_SCREENSHOT_DIR`). Failed comparisons also save magenta diff PNGs.
- Open `zig-out/screenshots/index.html` to browse all captures at full
  resolution.
- Update intentionally: set `UPDATE_GOLDEN=1` for the visual command above,
  inspect the images, then rerun without that variable.
- Optional: `RENDER_BACKEND=webgpu` or `webgl2` to run only that backend;
  `CHROMIUM=/path/to/chromium` to select the browser.

For repeatability the suite disables grain and cursor blinking, removes shell
prompts, waits for fonts/GPU/compositor readiness, and normalizes volatile
telemetry counters/timings while preserving its actual labels and layout.
Desktop uses detailed telemetry; mobile uses the default single-line mode.
Comparison checks both total changed pixels and local 64-pixel tiles, so dark
backgrounds cannot hide localized rendering regressions. The old cropped
terminal/telemetry/bottom-bar goldens have been removed.

Rebuild after changing application assets or WASM sources. For terminal-only
builds, see the [terminal package README](../wgpuTerminal/README.md).

## Source areas

- [web/](web/): application UI and session/reconnect behavior; see
  [connection lifecycle](../docs/connection-lifecycle.md).
- [go/](go/): HTTP/TLS, WebSockets, server configuration, and authentication:
  `go/internal/server/auth_totp.go` (the baseline factor and its limiter),
  `auth.go`/`auth_http.go`/`auth_cli.go` (state, endpoints, subcommands),
  `totp_qr.go` (terminal QR), and `go/cmd/bcwebmux-server/main.go`.
- [src/](src/): native sessions, persistence, and PTYs. `src/server.zig` is the
  legacy Zig server, not the default Go frontend.
- [build.zig](build.zig) and [test/](test/): build orchestration and
  application/reusable-terminal tests. Go and Zig tests also live alongside
  their sources.

See the [repository overview](../README.md) for the shared terminal components.
Architecture and design documents live in the repository-root
[docs/](../docs/README.md).
