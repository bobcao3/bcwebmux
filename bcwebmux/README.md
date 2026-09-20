# bcwebmux application

The complete remote-terminal application: browser UI, session management, and a Go HTTP(S)/WebSocket frontend backed by a native Zig session core and PTY worker.

## Core design

bcwebmux replicates a PTY session between the server and multiple clients. The
server and every client run the same libghostty terminal. The transport uses
state snapshots as its baseline, with compressed PTY diffs layered on top to
keep the replicas synchronized.

## Get started

Prerequisites: Zig 0.16.0, Node/npm, GNU tar, Linux, and a modern Chromium browser with WebGPU or WebGL2. `zig build` provisions a pinned Go toolchain itself and defaults to musl; no system Go or C toolchain is required.

```sh
# From the repository root
npm install
cd bcwebmux
zig build -Doptimize=ReleaseSmall
./zig-out/bin/bcwebmux-server
```

Open <http://localhost:8080>. Use `--help` for server options. Remote use should sit behind authenticated TLS and requires explicit host/origin options.

## Server configuration

New terminal sessions run the configured shell with `-l` (login shell), starting
in `$HOME`, independently of the server's working directory. An unset or empty
`HOME` falls back to the current user's passwd home directory. The home path must
be absolute; if it cannot be resolved or entered, session startup fails rather
than using the server's directory. Shell startup files may subsequently change
the terminal's directory. Existing sessions are unaffected.

`--config FILE` selects a TOML file explicitly (missing or unreadable files are fatal).
Otherwise the server reads the **first existing** file, without merging:

1. `$XDG_CONFIG_HOME/bcwebmux/config.toml`, defaulting to `$HOME/.config/bcwebmux/config.toml`.
   For compatibility, the nonstandard `$XDG_HOME` is used only when `XDG_CONFIG_HOME` is unset.
2. `$HOME/.bcwebmux.toml`.

Malformed TOML, unknown keys, and unreadable discovered files are fatal; `--help` does
not read configuration. All scalar CLI options override the file, including
`--http3=false`. Paths in TOML are relative to the process working directory;
there is no shell or tilde expansion. Supported keys are shown below, plus legacy
`host` and `origin` (single strings), `web-root`, `shell`, and `worker`.

Example `~/.config/bcwebmux/config.toml` (replace addresses, origins, and TLS paths
with your own; omit any range not present on this machine):

```toml
listen = ["100.64.0.0/10", "192.168.1.0/24", "127.0.0.1"]
port = 8443
origins = ["https://terminal.example.ts.net:8443", "https://192.168.1.20:8443", "https://localhost:8443"]
tls-cert = "/path/to/fullchain.pem"
tls-key = "/path/to/key.pem"
http3 = true
max-sessions = 16
```

`listen` accepts hostnames, IP literals, or CIDRs, all on the shared `port`.
Repeat `--listen` to replace the entire file list. Explicit `--host` clears the
file list for legacy single-host use; if both CLI options appear, `--listen` wins.
CIDRs select **only assigned local addresses**, never a wildcard socket. Overlapping
ranges and duplicate resolved addresses are deduplicated; each unmatched range is
an error. DNS and interfaces are resolved at startup, not watched: restart after
address changes. All TCP and (when enabled) UDP/HTTP3 sockets must bind successfully
or startup rolls them all back. Port zero chooses one shared ephemeral port.

When neither `listen` nor legacy `host` is provided, hostnames in `origins` are
resolved at startup and all resolved IPv4/IPv6 addresses assigned locally are
bound and deduplicated. Wildcard or remote-only results are rejected, and startup
fails if any hostname has no locally assigned address. Without `origins`, `listen`,
or `host`, the default remains `127.0.0.1`. Explicit `listen` or `host` overrides
this automatic resolution, which is needed for reverse proxies whose public
hostname is not locally assigned. Automatic resolution uses the configured port,
not origin ports, and is startup-only; restart after address changes. The exact
origin allowlist is unchanged, and IP aliases are not auto-trusted.

For example:

```toml
origins = ["https://bobcao3arch.local:3443"]
port = 3443
# Configure tls-cert and tls-key as shown above.
```

Repeat `--origin` to replace the file allowlist. Origins are exact browser-facing
scheme/host/port values, not CIDRs or wildcards. Non-loopback listeners require an
explicit allowlist; loopback-only listeners derive local origins if none is set.
Every mutation and WebSocket upgrade still requires exactly one allowed Origin;
this does not enable permissive CORS or disable CSRF checks. TLS certificates must
cover the names/IPs browsers use. HTTP/3 requires TLS and UDP access on the same
port as HTTPS. Origins are **not authentication**: restrict access with tailnet/
firewall policies or an authenticated TLS proxy. All listeners share one session
engine and assets. The startup log lists every bound address and accepted origin.

## Develop

From `bcwebmux/`:

```sh
zig build
zig build server-test
zig build unit-test
zig build kitty-proof-test
zig build test
zig build e2e
zig build visual-test
TEXT_RENDERER=canvas zig build text-renderer-test
```

`server-test` runs native server tests; `unit-test` runs Zig unit tests.
`kitty-proof-test` characterizes the pinned libghostty graphics APIs and snapshot
limitations in a separate graphics-enabled test build. It does not enable graphics
in the application; passing characterization tests is not feature acceptance.
The shell startup regression (requires `/bin/bash`) can also run directly:
`node test/session-shell-integration.mjs ./zig-out/bin/bcwebmux-server`.
`test` includes browser end-to-end tests, not just unit tests. Browser tests
require Chromium and a physical Vulkan GPU (no SwiftShader/llvmpipe).

`text-renderer-test` runs frame/font contracts, full-viewport goldens, GPU input
tests and core/font-lifecycle tests (including DPR 4) without the unrelated
session-transport recovery suite. Use `TEXT_RENDERER=canvas` for the GPU input
tests' browser text path; omit it to exercise kb/STB there. Test server launches
ignore personal server configuration without changing browser fontconfig.

### Glyph texture inspector

Settings → **PERF → VIEW GLYPH TEXTURE** opens a snapshot of the shared glyph
atlas on either GPU backend. Use **REFRESH** to capture again or **Actual pixels**
for an unscaled, scrollable view. The grayscale image shows the R8 alpha mask,
including unused/stale cache slots, not a second rendering of the terminal.
Debug captures are limited to 16 Mi pixels and run only on request.

### Full-screen visual regression tests

`zig build visual-test` runs the screenshot suite alone; `e2e` and `test` also
include it. Both WebGPU and WebGL2 are tested at fixed viewport sizes:

| Device | CSS viewport | DPR | Screenshot pixels |
| --- | --- | --- | --- |
| Desktop | 1440 × 900 | 1 | 1440 × 900 |
| Mobile (touch) | 390 × 844 | 3 | 1170 × 2532 |

Each captures the **entire viewport**, including terminal, telemetry, scrollbar,
and bottom controls. Cases cover UTF-8 (CJK, combining accents, Greek/Cyrillic),
emoji, ANSI styles/box drawing, and numbered `test/snapshot-fixture.zig` source.
Scrollback cases capture the bottom, Home/top, and PageDown/middle; End must
restore the original bottom image. Source is sent through the real shell/PTY.
The Unicode preview uses browser `canvas`; source/scrollback uses the default
`kb-stb`, covering both text paths. Canvas uses the CSS/system font stack for
CJK and emoji fallback. The test observes actual terminal `fillText` calls and
checks nonblank alpha that differs from missing-glyph boxes, including combining
marks, variation selectors, skin tones, flags and ZWJ sequences, before comparing
screenshots. `*-font-probe.json` records that evidence. The shipped Noto Emoji web
font and installed Noto CJK fonts provide this test environment's fallback coverage;
install those CJK fonts for reproducible baselines. Color emoji RGB remains outside
the alpha-only atlas contract. kb/STB still depends on the supplied TTF coverage.
See the [font contract](../wgpuTerminal/README.md#text-paths-and-fonts).

The Fira Code menu option uses an installed/browser-provided font and selects
Canvas automatically. If Fira Code is unavailable, its configured fallback stack
is used; the option does not add an external font download.

- Baselines: `test/golden/{desktop,mobile}-{webgpu,webgl2}-*.webp`.
- Actual PNGs and renderer-state JSON: `zig-out/screenshots/` (override with
  `BCWEBMUX_SCREENSHOT_DIR`). Failed comparisons also save magenta diff PNGs.
- Open `zig-out/screenshots/index.html` to browse all captures at full resolution.
- Update intentionally: `UPDATE_GOLDEN=1 zig build visual-test`, inspect the
  images, then rerun without `UPDATE_GOLDEN`.
- Optional: `RENDER_BACKEND=webgpu` or `webgl2` to run only that backend;
  `CHROMIUM=/path/to/chromium` to select the browser.

For repeatability the suite disables grain and cursor blinking, removes shell
prompts, waits for fonts/GPU/compositor readiness, and normalizes volatile
telemetry counters/timings while preserving its actual labels and layout.
Desktop uses detailed telemetry; mobile uses the default single-line mode.
Comparison checks both total changed pixels and local 64-pixel tiles, so dark
backgrounds cannot hide localized rendering regressions. The old cropped
terminal/telemetry/bottom-bar goldens have been removed.

Rebuild after changing application assets or WASM sources. For terminal-only builds, see the [terminal package README](../wgpuTerminal/README.md).

## Source areas

- [web/](web/): application UI and session/reconnect behavior; see [connection lifecycle](../docs/connection-lifecycle.md).
- [go/](go/): HTTP/TLS, WebSockets, and server configuration.
- [src/](src/): native sessions, persistence, and PTYs. `src/server.zig` is the legacy Zig server, not the default Go frontend.
- [build.zig](build.zig) and [test/](test/): build orchestration and application/reusable-terminal tests. Go and Zig tests also live alongside their sources.

See the [repository overview](../README.md) for the shared terminal components.
Architecture and design documents live in the repository-root [docs/](../docs/README.md).
