# bcwebmux

Requires Zig 0.16, GNU tar, zstd, libzstd development headers/library, woff2_compress, Node.js/npm, Linux PTY support, a WebGPU-capable browser, and Chromium for tests. WebGPU requires HTTPS except on loopback.
Zig fetches the pinned Nerd Fonts v3.5.0 archive and converts the four selected JetBrainsMono Nerd Font Mono faces to WOFF2 during the build; the SIL OFL remains at `web/fonts/OFL.txt`, and the Noto Emoji license is shipped at `web/fonts/NotoEmoji-OFL.txt`. JetBrains Mono is the bundled stb font. The build also bundles the OFL Noto Emoji monochrome face as a Canvas fallback. Fira Code 400/700 is loaded as WOFF2 from Google Fonts and is available only with KB + Canvas. The CSP allowlist is limited to fonts.googleapis.com for styles and fonts.gstatic.com for font data.

```sh
zig build server -Doptimize=ReleaseSmall
```

Every server binary embeds a deterministic zstd-compressed tar web bundle. At startup it decompresses and indexes the bundle into an in-memory VFS, so the server can run without web files, including directly as `zig-out/bin/bcwebmux-server`.

For development, `zig build server` passes `zig-out/web` as a live overlay. Rebuilding with `zig build` updates the assets, and the running server opens each overlay file per request, so refreshing the browser picks up HTML, JS, CSS, WASM, and font changes without restarting. Missing overlay files fall back to the embedded VFS.

PTY output uses the negotiated `bcw.zstd.v1` WebSocket subprotocol, with one persistent Zstandard level-1 stream per live connection, a 128 KiB window, and flushes without routine stream resets. The browser decodes it with the bundled same-origin `fzstd` module. Telemetry's decoded/wire compression ratio is decoded PTY bytes divided by bytes sent on the wire; higher values indicate more compression.

Select `KB + stb_truetype` or `KB + Canvas` from Settings → FONT; switching applies live. Settings → FONT also provides an independently persisted fallback-family priority list for each primary font; Fira's default stack includes the bundled JetBrains Mono Nerd Font late in the list for symbols. The default Canvas fallback chain includes the bundled OFL Noto Emoji monochrome face, so emoji render monochromatically while color emoji remain unsupported. Editing the active fallback list invalidates and repopulates the bounded glyph cache. `KB + Canvas` keeps Ghostty/KB shaping boundaries and Zig cache/slot ownership, but rasterizes complete UTF-8 runs through Canvas for hinting and fallback. It batches all cache-miss run descriptors and text into one WASM-to-JS raster call per frame, stores alpha-only `r8` masks, and intentionally does not support colored emoji. The old `?renderer=canvas` path no longer exists.

Open <http://127.0.0.1:8080>. Pass server options after `--`, for example `-- --port 9000 --shell /bin/bash`. The default listener is loopback-only.
bcwebmux can be installed as a PWA using the browser's Install or Add to Home Screen action. Installed launches request fullscreen, with standalone mode as a fallback to remove browser chrome; installation from a non-loopback address requires HTTPS. In installed fullscreen/standalone mode, the lower controls row intentionally extends into the mobile system gesture/navigation safe area instead of reserving extra space.
Drag to select terminal text when application mouse reporting is inactive. On no-mouse/coarse touch devices, the T-plus-selection-pointer icon at the left of the bottom controls freezes incoming display output and enables native selection handles when tapped; tap it again to return to live output and apply queued output. The softkey row is shown by default on coarse-touch systems, hidden by default on keyboard/fine-pointer systems, and can be shown or hidden with the keyboard icon in the bottom-left controls. When a TUI captures mouse input, hold Shift before pressing to force local selection. Copy with Ctrl+Shift+C or Meta+C; plain Ctrl+C is sent to the terminal application.
Remote exposure requires `--host` and the exact browser `--origin`, and should be placed behind an authenticated TLS reverse proxy.

```sh
npm install
zig build e2e -Doptimize=ReleaseSmall
zig build test -Doptimize=ReleaseSmall
```

Rendered terminal/telemetry/bottom-bar regressions use PSNR comparisons against `test/golden` lossless WebP fixtures; intentional visual changes update them with `UPDATE_GOLDEN=1 zig build e2e` followed by a normal test run.

`zig build e2e` requires a physical Vulkan GPU exposed to Chromium and intentionally rejects SwiftShader and llvmpipe. The browser test uses a 1024×720 window at fractional DPR 1.25 and verifies that the WebGPU backing texture matches the native device-pixel content box. It validates truecolor cells, normal and Nerd-font glyph pixels, IME/Backspace/Enter, softkeys, mouse, and scrollback using GPU texture readbacks plus a CDP compositor screenshot—not CPU cell or text inspection.

## License

This project is licensed under the [MIT License](LICENSE).
