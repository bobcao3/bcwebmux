# bcwebmux

Requires Zig 0.16, GNU tar, zstd, libzstd development headers/library, woff2_compress, Node.js/npm, Linux PTY support, a WebGPU-capable browser, and Chromium for tests. WebGPU requires HTTPS except on loopback.
Zig fetches the pinned Nerd Fonts v3.5.0 archive and converts the four selected JetBrainsMono Nerd Font Mono faces to WOFF2 during the build; the SIL OFL remains at `web/fonts/OFL.txt`. No font CDN or runtime network request is needed.

```sh
zig build server -Doptimize=ReleaseSmall
```

Every server binary embeds a deterministic zstd-compressed tar web bundle. At startup it decompresses and indexes the bundle into an in-memory VFS, so the server can run without web files, including directly as `zig-out/bin/bcwebmux-server`.

For development, `zig build server` passes `zig-out/web` as a live overlay. Rebuilding with `zig build` updates the assets, and the running server opens each overlay file per request, so refreshing the browser picks up HTML, JS, CSS, WASM, and font changes without restarting. Missing overlay files fall back to the embedded VFS.

PTY output uses the negotiated `bcw.zstd.v1` WebSocket subprotocol, with one persistent Zstandard level-1 stream per live connection, a 128 KiB window, and flushes without routine stream resets. The browser decodes it with the bundled same-origin `fzstd` module. Telemetry's decoded/wire compression ratio is decoded PTY bytes divided by bytes sent on the wire; higher values indicate more compression.

Open <http://127.0.0.1:8080>. Pass server options after `--`, for example `-- --port 9000 --shell /bin/bash`. The default listener is loopback-only.
Remote exposure requires `--host` and the exact browser `--origin`, and should be placed behind an authenticated TLS reverse proxy.

```sh
npm install
zig build e2e -Doptimize=ReleaseSmall
zig build test -Doptimize=ReleaseSmall
```

Rendered terminal/telemetry/bottom-bar regressions use PSNR comparisons against `test/golden` lossless WebP fixtures; intentional visual changes update them with `UPDATE_GOLDEN=1 zig build e2e` followed by a normal test run.

`zig build e2e` requires a physical Vulkan GPU exposed to Chromium and intentionally rejects SwiftShader and llvmpipe. The browser test uses a 1024×720 window at fractional DPR 1.25 and verifies that the WebGPU backing texture matches the native device-pixel content box. It validates truecolor cells, normal and Nerd-font glyph pixels, IME/Backspace/Enter, softkeys, mouse, and scrollback using GPU texture readbacks plus a CDP compositor screenshot—not CPU cell or text inspection.
