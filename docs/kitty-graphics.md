# Kitty graphics

The native server and WASM terminal implement a bounded **static** subset of
[Kitty graphics](https://sw.kovidgoyal.net/kitty/graphics-protocol/). Browser
rendering works on WebGPU and WebGL2. This is not full Kitty compatibility.

## Supported behavior

- Direct RGB, RGBA and PNG payloads, including zlib compression, chunked
  uploads, query, display, replacement and deletion. The server alone sends
  protocol replies; browser replicas and replay do not.
- Pinned, relative and Unicode-placeholder virtual placements, clipping,
  alternate screens and scrollback. Negative-z images render beneath glyphs
  without being erased by default cell backgrounds; nonnegative-z images render
  above text. The cell background is opaque, so images with
  `z < -1073741824` are culled: they would be hidden behind every background
  pixel. Placeholder codepoints are stored in terminal text but not rasterized
  as glyphs.
- Source bytes travel in the existing PTY-output stream, not a separate image
  channel. Ghostty owns image IDs, placements, cursor behavior and decoded-byte
  accounting. The shared Zig adapter owns encoded bytes; browser textures are
  disposable presentation state.
- Frame ABI v7 carries bounded graphics resource/draw records. Source bytes are
  copied while the WASM frame lease is valid; browser decoding is asynchronous
  and bounded. Both renderers blend RGBA pixels. Browser decoding does not send
  delayed Kitty replies or change logical terminal state.
- Session checkpoints wrap the VT snapshot with a bounded `KGST` logical-image
  envelope. Legacy VT-only snapshots remain readable. If historical encoded
  bytes are unavailable after restore, image identity and protocol behavior
  persist but the image remains undrawn until retransmission. Capture waits for
  a complete APC/chunk boundary, then applies ordered PTY output once.

Unsupported: animation commands, filesystem/temporary-file/shared-memory
sources, and the rest of Kitty's full protocol. A PNG's signature, IHDR and
IHDR CRC and its bounded compressed-stream length are validated at logical
admission; full raster validation happens in the browser. Thus a successful
protocol reply does **not** guarantee that a damaged PNG can be displayed.
Browser decode currently runs asynchronously on the main thread, not in a Web
Worker. Visibility suspension, graphics device loss and overload behavior have
not been verified by the browser screenshot test.

Limits include 4096 pixels per side, 16 MiB of decoded-byte accounting per
image, 8 MiB of encoded bytes per upload, 32 MiB of retained source bytes,
512 images and 2048 placements per screen, a 256 KiB graphics checkpoint and a
32 MiB browser decoded-texture budget. Exceeding logical limits returns a
protocol error; missing browser resources leave images undrawn without
changing terminal state.

## Build dependency

`app-bcwebmux/build.zig.zon` fetches the `bobcao3/ghostty` fork's
`bcwebmux/wasm-kitty-graphics` branch at commit `a21f94b` by URL, with a
verified hash. No local checkout or submodule is needed. Four patches enable
freestanding Kitty graphics, exclude OS-backed image loaders on WASM, expose
Ghostty's APC dispatch through a stream-handler hook, and export
`device_attributes`. Upstream's VT snapshot omits image/placement registries,
which is why `KGST` exists.

To bump the pin, rebase `bcwebmux/wasm-kitty-graphics` in the `bobcao3/ghostty`
fork onto upstream `main` and push it. Then update `.url` to the new commit and
`.hash` (printed by `zig fetch <url>`) in `app-bcwebmux/build.zig.zon`.

## Verification

From this repository root:

```sh
cd app-bcwebmux
zig build terminal-wasm install test gotest --summary all
node test/render-frame-contract.mjs
node test/session-api-integration.mjs zig-out/bin/bcwebmux-server
node test/session-browser-resume.mjs zig-out/bin/bcwebmux-server zig-out/web
RENDER_BACKEND=webgl2 node test/session-browser-resume.mjs zig-out/bin/bcwebmux-server zig-out/web
node test/visual-e2e.mjs zig-out/bin/bcwebmux-server zig-out/web
```

The HTTPS browser test reads actual pixels for raw and chunked zlib PNG
images, z layers, RGBA blending, relative and virtual placement, deletion,
alternate screens and reconnect on both backends. When `viu` is installed,
the same test exercises its DA1/Kitty probes and a 5.7 MiB raw image on both
backends. The native continuation test
compares old-ID operations and subsequent text after checkpoint restore. The
desktop/mobile visual suite also compares a Kitty RGBA image against committed
`kitty-graphics` goldens on both backends, using its existing full-viewport
capture and diff framework. Browse the resulting PNGs in
`app-bcwebmux/zig-out/screenshots/index.html`. Browser tests require
Chromium and OpenSSL for their temporary local certificate. An intermittent
Go runtime/cgo crash was observed during some reconnect runs and has not been
isolated; passing reruns do not establish that the flake is resolved.
