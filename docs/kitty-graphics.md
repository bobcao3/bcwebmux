# Kitty graphics

The native server and WASM terminal implement a bounded **static** subset of
[Kitty graphics](https://sw.kovidgoyal.net/kitty/graphics-protocol/). Browser
rendering works on WebGPU and WebGL2. This is not full Kitty compatibility.

## Supported behavior

- Direct RGB, RGBA and PNG payloads, including zlib compression, chunked
  uploads, query, display, replacement and deletion. A PNG-format (`f=100`)
  payload may also be a still WebP image, admitted by its RIFF and frame
  headers; this is how the server forwards re-encoded uploads
  ([WebP transcoding](#webp-transcoding)). The server alone sends protocol
  replies; browser replicas and replay do not.
- Pinned, relative and Unicode-placeholder virtual placements, clipping,
  alternate screens and scrollback. Negative-z images render beneath glyphs
  without being erased by default cell backgrounds; nonnegative-z images render
  above text. The cell background is opaque, so images with `z < -1073741824`
  are culled: they would be hidden behind every background pixel. Placeholder
  codepoints are stored in terminal text but not rasterized as glyphs.
- Source bytes travel in the existing PTY-output stream, not a separate image
  channel. Ghostty owns image IDs, placements, cursor behavior and decoded-byte
  accounting. The shared Zig adapter owns encoded bytes; browser textures are
  disposable presentation state.
- Frame ABI v8 carries bounded graphics resource/draw records. Source bytes are
  copied while the WASM frame lease is valid; browser decoding is asynchronous
  and bounded. Both renderers blend RGBA pixels. Browser decoding does not send
  delayed Kitty replies or change logical terminal state.
- Session checkpoints wrap the VT snapshot with a bounded `KGST` logical-image
  envelope. The restore path also accepts VT-only snapshots. If historical
  encoded bytes are unavailable after restore, image identity and protocol
  behavior persist but the image remains undrawn until retransmission. Capture
  waits for a complete APC/chunk boundary, then applies ordered PTY output once.

Unsupported: animation commands, filesystem/temporary-file/shared-memory
sources, and the rest of Kitty's full protocol. A PNG's signature, IHDR and IHDR
CRC and its bounded compressed-stream length are validated at logical admission;
full raster validation happens in the browser. Thus a successful protocol reply
does **not** guarantee that a damaged PNG can be displayed. Browser decode
currently runs asynchronously on the main thread, not in a Web Worker. The
browser screenshot test does not cover visibility suspension, graphics device
loss or overload behavior.

Limits include 4096 pixels per side, 16 MiB of decoded-byte accounting per
image, 8 MiB of encoded bytes per upload, 32 MiB of retained source bytes, 512
images and 2048 placements per screen, a 256 KiB graphics checkpoint and a 32
MiB browser decoded-texture budget. Exceeding logical limits returns a protocol
error; missing browser resources leave images undrawn without changing terminal
state.

## WebP transcoding

To save bandwidth, the server re-encodes each complete image upload as WebP
before journaling it, so the mirror terminal, every browser and checkpoint
replay all receive the smaller stream. Raw RGB, raw RGBA and PNG uploads,
chunked or zlib-compressed, are encoded lossily at the configured quality.
Images with few distinct colors, such as plots, charts and screenshots, are also
encoded losslessly, and the smaller result wins, so they keep exact pixels. The
rewritten upload keeps its image ID or number, placement keys and quiet setting,
so replies and logical state match the original. Set `webp-quality = 0` in the
server config, or pass `--webp-quality=0`, to forward uploads byte for byte.

An upload passes through unchanged when it is small, when WebP would not shrink
it substantially, when it is invalid or already WebP, or when the stream around
it is irregular: other output between its chunks, unusual control keys or
terminators, or an upload the mirror is still assembling. A rewritten RGB image
counts as RGBA toward each screen's decoded-byte budget, as PNG images already
do. Encoding runs on the session's output path, so an image reaches browsers
after tens to hundreds of milliseconds of CPU time; later output from that
session waits behind it. PNG is decoded on the server with Ghostty's memory-safe
Wuffs decoder; the browser still decodes every image it draws.

## Build dependency

`app-bcwebmux/build.zig.zon` pins the `bobcao3/ghostty` fork at
[`acf31468a`](https://github.com/bobcao3/ghostty/commit/acf31468a65f6b9f11e97987dc08fe442e5f4049),
based on upstream main
[`c770410db`](https://github.com/ghostty-org/ghostty/commit/c770410dbb57909ff4f6921a6497688a957f85db),
with a verified archive hash. No local checkout or submodule is needed. Three
patches enable freestanding Kitty graphics, exclude OS-backed image loaders on
WASM, and expose Ghostty's APC dispatch through a stream-handler hook. Upstream
exports `device_attributes`. Upstream's VT snapshot omits image/placement
registries, which is why `KGST` exists. The server also links libwebp, pinned in
the same manifest and built by `app-bcwebmux/build/webp.zig` with libwebp's
runtime SIMD dispatch, and imports Wuffs from the Ghostty dependency.

To bump the pin, rebase the fork patches onto upstream `main` in a clean
worktree, retain only patches absent from upstream, and push
`bcwebmux/wasm-kitty-graphics` with `--force-with-lease`. Then update `.url` to
the new commit and `.hash` (printed by `zig fetch <url>` from `app-bcwebmux/`)
in `app-bcwebmux/build.zig.zon`. Update `terminal_abi` in
`app-bcwebmux/src/session_manifest.zig`, the matching SHA-256 digest in
`app-bcwebmux/web/SessionWire.js`, and the protocol test constants when changing
terminal semantics. The client and server require matching compatibility
identifiers before replaying PTY output.

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

The HTTPS browser test reads actual pixels for raw and chunked zlib PNG images,
z layers, RGBA blending, relative and virtual placement, deletion, alternate
screens and reconnect on both backends. When `viu` is installed, the same test
exercises its DA1/Kitty probes and a 5.7 MiB raw image on both backends. The
native continuation test compares operations on restored image IDs and
subsequent text after checkpoint restore. The desktop/mobile visual suite also
compares a Kitty RGBA image against committed `kitty-graphics` goldens on both
backends, using its existing full-viewport capture and diff framework. Browse
the resulting PNGs in `app-bcwebmux/zig-out/screenshots/index.html`. Browser
tests require Chromium and OpenSSL for their temporary local certificate. The
native I/O runtime installs SIGIO/SIGPIPE handlers with `SA_ONSTACK` so the
handlers use alternate signal stacks when a signal interrupts a Go thread.
Native tests check the flags and handler restoration; a Go subprocess stress
test delivers both signals on Go threads and scans their stacks afterward.

`zig build test` checks that rewritten uploads draw the same replies and image
state from a real terminal as the originals, and that every other byte passes
through unchanged. The browser test also draws a server-rewritten WebP upload
and checks that the server journaled a fraction of its original size.
