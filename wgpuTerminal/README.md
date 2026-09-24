# @bcwebmux/wgpu-terminal

Embeddable GPU terminal frontend using WebGPU with a WebGL2 fallback, used by bcwebmux. The package owns terminal emulation, rendering, keyboard/IME input, pointer handling, scrollback, and selection. It does not create a PTY or choose a transport.

## Build and consume

The package is currently a private npm workspace, not a published npm install.
For a single-file asciinema playback example, see [`../example-terminal/asciinema_playback.html`](../example-terminal/asciinema_playback.html).
To build and pack it from this checkout (Zig 0.16.0 and Node/npm required):

```sh
# From the repository root
npm install
npm pack --workspace=@bcwebmux/wgpu-terminal
```

The `prepack` script builds only the `terminal-wasm` target through
`app-bcwebmux/build.zig` and copies WASM/fonts into `wgpuTerminal/dist/`; it does not
build the Go server. Install the resulting tarball in your application, or use
the workspace directly after running `node wgpuTerminal/scripts/prepare-wasm.mjs`.

Your application supplies:

- A DOM container, the package CSS, and a browser with WebGPU or WebGL2 support.
- A served URL for the package's `terminal.wasm`, passed as `wasmUrl`, and the
  four packaged TTF fonts under `fonts/` beside it (or explicit `wasmFontUrls`).
  Configure CSS font faces to match. Ship matching JavaScript and WASM assets.
- Your own backend/transport if you want an interactive shell: feed backend
  output to `terminal.write(bytes)`, forward `terminal.onData` to the backend,
  and forward `terminal.onResize` to its PTY resize operation.

You do not need bcwebmux's session UI, wire protocol, Go server, or native PTY
worker to embed the terminal. You still need `common/terminal` and the current
build files **when building its WASM from source**; consumers of the packed
assets do not need Zig or the repository at runtime.

For a WASM-only build, run `zig build terminal-wasm` from `app-bcwebmux/`. Assets are emitted under `app-bcwebmux/zig-out/wgpu-terminal/`; the preparation script copies them into `wgpuTerminal/dist/`. These paths are relative to the repository root.

## Integration

```js
import { Terminal } from "@bcwebmux/wgpu-terminal";
import "@bcwebmux/wgpu-terminal/css/terminal.css";

const terminal = new Terminal({
  wasmUrl: "/assets/terminal.wasm",
  renderer: "kb-stb",
  renderBackend: "auto",
  font: {
    cssFamily: "JetBrains Mono Nerd Font",
    size: 15,
    ligatures: true,
    fallbacks: ["ui-monospace", "Noto Emoji", "monospace"],
  },
  theme,
  grainStrength: 4,
});

terminal.onData((bytes) => backend.send(bytes));
terminal.onResize(({ cols, rows }) => backend.resize(cols, rows));
backend.onData((bytes) => terminal.write(bytes));

await terminal.open(document.querySelector("#terminal-container"));
terminal.focus();
```

## Render backends

`auto` is the default and tries WebGPU before WebGL2. Set `renderBackend` to
`webgpu` or `webgl2` to force a backend for diagnostics. Backend choice does
not change the `kb-stb`/`canvas` text renderer. Optional `powerPreference:
"low-power"` or `"high-performance"` hints GPU selection; omitting it leaves
the hint unset and uses the browser's default policy.

Device loss suspends presentation while Terminal recreates the selected backend
on the same canvas. WebGL waits for `webglcontextrestored`. Pipelines, grain,
glyph partitions and full text masks are rebuilt from retained cores/font state;
terminal identities and logical state are not reset or replayed. Recovery errors
emit `onError` and leave presentation suspended. `readPixels()` retains its
last-presentation capture behavior when the backend is available.

`await terminal.readGlyphAtlas()` captures the shared glyph texture on demand,
returning top-first R8 bytes plus texture/grid/cell dimensions. Debug snapshots
are limited to 16 Mi pixels, reject concurrent reads and renderer changes, and
do not retain GPU resources after readback. They include unused/stale cache slots.

`TerminalCore` and `FramePacket` alone access WASM exports/memory. Controllers use
semantic callbacks and perform DOM coordinate conversion. Terminal versions one
frozen render-metric configuration shared with cores, backend, pointer and IME;
CSS cell metrics also drive the text mirror. `FramePresenter` owns submission
state and `FrameScheduler` alone schedules presentation. The v7 frame carries
STB alpha masks or bounded UTF-8 Canvas requests, plus bounded Kitty image
sources and placements; it does not carry glyph outlines.

## Text paths and fonts

`terminal.wasm` contains no fonts. For `kb-stb`, the default loader fetches four
`JetBrainsMonoNerdFontMono` TTF files from `fonts/` beside `wasmUrl`, in
regular, bold, italic, and bold-italic order. Fetched face bytes are cached
and shared across cores; each core copies a face into its own linear memory
only when that style is first rendered. The package exports these files under
`@bcwebmux/wgpu-terminal/fonts/*`; consumers may provide a `wasmFontUrls`
array in the same order. CSS `@font-face` declarations should point at the
same URLs so the HTTP cache serves both browser and WASM users.

- **`kb-stb`** shapes supplied font bytes with kb and rasterizes with STB in
  WASM. CSS fallbacks affect DOM measurement/text mirrors, not this raster path.
  Missing characters remain subject to the supplied font's coverage.
- **`canvas`** uses browser `fillText`, with the configured `cssFamily` and
  `fallbacks`, for shaping and rasterization. Browser/system fonts supply CJK,
  emoji and other characters missing from the primary face. It does not fetch
  WASM font bytes or call kb/STB. Browser-only `canvasOnly` fonts are accepted.
  Coverage depends on the available fonts; web fonts need CSS `@font-face` rules.

Both paths retain WASM terminal widths/graphemes and use the same R8 alpha atlas
on either GPU backend. Browser glyph positioning may differ from kb. Emoji are
rendered as coverage in the terminal foreground color, not color-glyph RGB.
Canvas preserves combining marks, variation selectors and ZWJ sequences within
one text request. Font-loading completion invalidates cached fallback masks.

Use `await terminal.setRenderer("canvas")` or `await terminal.setRenderer("kb-stb")`.
Switching to kb/STB loads its font bytes before committing; load failure leaves
the previous path active. `TerminalCore.setRenderer` is asynchronous too. A
standalone Canvas core being attached to a kb/STB host must first await
`core.setRenderer("kb-stb")`; `createCore()` prepares the host's requirements.
The application migrates old persisted `kb-canvas` settings to `canvas`.

## WASM diagnostics

Ship matching JavaScript and WASM assets. The freestanding module imports
`host.terminal_log(level, ptr, len)`; `TerminalCore` supplies it and forwards
messages to the browser console (error=0, warn=1, info=2, debug=3). Custom WASM
hosts must implement this import and consume its borrowed UTF-8 bytes during
the callback. Native formatting is allocation-free and bounded to 2,048 bytes.

## More than one terminal

Create a core for each terminal state and attach the one that should be visible. Cores can keep receiving backend output while another is on screen, and snapshots can be restored before attachment.

```js
const other = await terminal.createCore();
other.write(bytes);
terminal.attachCore(other);
terminal.restoreSnapshot(snapshot, other);
```

`write()` is backend output into the terminal; `onData` is user input. `TerminalCore.onReply` separates parser replies. Callback byte views are borrowed synchronously and must be copied if retained.

For server-authoritative session transports, set `canonicalGeometry: true`, send only `TerminalCore.onData`, apply accepted server dimensions with `resizeCanonical`, use `setReplayMode` during historical tail application, and never forward `onReply`.

## Development

- [src/](src/): public API, WASM hosting, browser input, selection, scrolling, and GPU rendering.
- [index.d.ts](index.d.ts): public API types.
- [../common/terminal/](../common/terminal/): low-level WASM engine; see the [glyph-cache design](../docs/glyph-cache-design.md).
- [../app-bcwebmux/test/](../app-bcwebmux/test/): browser and contract tests shared with the application. See the [application README](../app-bcwebmux/README.md#develop) for test commands.

Rebuild WASM assets after changing the low-level engine. See the [repository overview](../README.md) for component boundaries.
Run JavaScript contracts directly with Node, outside `zig build`; see the
[application development guide](../app-bcwebmux/README.md#develop). The physical
terminal-core browser test also accepts
`RENDER_RECOVERY=1` with `RENDER_BACKEND=webgpu` or `webgl2` to force device/context
loss and verify recovery before running the normal core/atlas/capture checks.
Architecture and design documents live in the repository-root [docs/](../docs/README.md).
