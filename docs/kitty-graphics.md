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
  codepoints are stored in terminal text but not rasterized as glyphs. Ghostty's
  render state resolves every placement, including those of images whose pixels
  only the browser decodes; the shared scene converts its pixel geometry from
  the terminal's cell size to the glyph cell size.
- Source bytes travel in the existing PTY-output stream, not a separate image
  channel. Ghostty owns image IDs, placements, cursor behavior and decoded-byte
  accounting. The shared Zig adapter owns encoded bytes; browser textures are
  disposable presentation state.
- Frame ABI v8 carries bounded graphics resource/draw records. Source bytes are
  copied while the WASM frame lease is valid; browser decoding is asynchronous
  and bounded. Both renderers blend RGBA pixels. Browser decoding does not send
  delayed Kitty replies or change logical terminal state.
- Session checkpoints are Ghostty VT snapshots, whose Kitty graphics records
  carry images, placements and image IDs. Mirror images have no decoded pixels,
  so they restore pending: image identity and protocol behavior persist, but an
  image remains undrawn until retransmission because its encoded bytes are not
  in the checkpoint. Capture waits for a complete APC/chunk boundary, then
  applies ordered PTY output once.

Unsupported: animation commands, filesystem/temporary-file/shared-memory
sources, and the rest of Kitty's full protocol. The worker validates complete
raster data before forwarding an upload. The shared adapter separately checks
image headers and byte accounting at logical admission. A successful protocol
reply guarantees logical admission, not successful browser presentation. Browser
decode currently runs asynchronously on the main thread, not in a Web Worker.
The browser screenshot test does not cover visibility suspension, graphics
device loss or overload behavior.

The PTY worker accepts larger source images than the journal and browser can
retain. The worker clamps image resolution before forwarding an upload; the
[normalizer](../app-bcwebmux/src/GraphicsTranscoder.zig) defines source and
output budgets. An upload that exceeds those budgets or cannot be normalized
receives a protocol error. The worker discards the remaining image chunks
without terminating the shell. The
[graphics adapter](../common/terminal/graphics/Adapter.zig) also bounds retained
images and placements. Missing browser resources leave images undrawn without
changing terminal state.

## WebP transcoding

The PTY worker normalizes each complete direct upload before sending output to
the server journal. The mirror terminal, every browser and checkpoint replay
receive the same normalized stream. The worker uses libwebp's
`WebPPictureRescale` to clamp resolution while preserving aspect ratio. Raw RGB,
raw RGBA, PNG and still WebP sources can reach that path, including chunked and
zlib-compressed uploads. The worker encodes images lossily at the configured
quality. Images with few distinct colors, such as plots, charts and screenshots,
are also encoded losslessly, and the smaller result wins. Lossless encoding
preserves the pixels after any resolution clamping. The rewritten upload keeps
its image ID or number, placement keys and quiet setting, so clients retain
image identity and explicit cell placement. Pixel-based placements after
resizing refer to the normalized image dimensions; implicit cell sizing also
uses those dimensions. The worker rejects a transmit-and-display upload with a
source crop when resizing would change the crop's pixel coordinates. Set
`webp-quality = 0` in the server config, or pass `--webp-quality=0`, to disable
optional bandwidth transcoding. Resolution clamping and rejection of unsafe
uploads remain active at zero quality.

A bounded upload can pass through unchanged when the image is small, when WebP
would not shrink the payload substantially, or when the source already uses
WebP. An upload that needs clamping always follows the normalization path.
Malformed or interrupted uploads receive bounded errors rather than entering the
journal with their original payloads. Before sending a large normalized upload,
the worker asks the server to reserve journal capacity at the upload boundary.
Slow browser acknowledgements cannot exhaust retention halfway through that
upload. A rewritten RGB image counts as RGBA toward the decoded-byte budget.
Encoding runs in the worker, so later output from the same session waits for
image processing. The worker decodes PNG with Ghostty's memory-safe Wuffs
decoder; the browser still decodes every image the browser draws.

## Build dependency

`app-bcwebmux/build.zig.zon` pins the `bobcao3/ghostty` fork at
[`728bbef6c`](https://github.com/bobcao3/ghostty/commit/728bbef6c4738f448b8c7afcdd7a21e5c8a3a9fa),
based on upstream main
[`08a951834`](https://github.com/ghostty-org/ghostty/commit/08a9518340e19487bd5fdf96963583fb32f0c41f),
with a verified archive hash. No local checkout or submodule is needed. Three
patches remain:

- Kitty graphics on freestanding targets. Upstream still disables it there,
  although it no longer reads a clock; the patch rejects the OS-backed media
  whose loaders do not compile for WASM.
- A `kitty_graphics` stream-handler effect, through which the adapter applies
  its limits and keeps encoded bytes.
- A render-state `pending_images` option. The WASM terminal never holds decoded
  pixels, and the render state otherwise omits placements of such images.

C translation uses the official `translate_c` package at Ghostty's commit, since
Zig 0.17 removed `@cImport`. The server also links libwebp, pinned in the same
manifest and built by `app-bcwebmux/build/webp.zig` with libwebp's runtime SIMD
dispatch, and imports Wuffs from the Ghostty dependency.

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

`zig build test` checks protocol replies and image state for bounded uploads,
rejection recovery, and preservation of ordinary terminal output. The browser
test draws worker-normalized WebP uploads, exercises large PPM images with
`viu`, and checks pixels, journal size and shell survival after oversized APCs.
