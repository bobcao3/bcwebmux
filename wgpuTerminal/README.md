# @bcwebmux/wgpu-terminal

Embeddable GPU terminal frontend using WebGPU with a WebGL2
fallback. The package owns terminal emulation, rendering,
keyboard/IME input, pointer handling, scrollback, and selection.
It does not create a PTY or choose a transport, and it is not
an xterm.js-compatible drop-in. The API is [index.d.ts](index.d.ts).

## Build and consume

Private npm workspace (no published install); building needs
Zig 0.16.0 and Node/npm. Packed-asset consumers need no Zig.

```sh
npm install; npm pack --workspace=@bcwebmux/wgpu-terminal
```

Run the above from the repository root. `prepack` builds only
`terminal-wasm` through `app-bcwebmux/build.zig`, not the Go
server. Or use the workspace after
`node wgpuTerminal/scripts/prepare-wasm.mjs`.

Your application supplies a DOM container, the package CSS, a
browser with WebGPU or WebGL2, a served `terminal.wasm` URL as
`wasmUrl` with the four TTFs under `fonts/` beside it in
regular, bold, italic, bold-italic order (or explicit
`wasmFontUrls`), plus `OFL.txt` and the coverage-probe TTFs.
Match CSS font faces; ship matching JS and WASM assets. Your
backend feeds `terminal.write(bytes)` and receives
`terminal.onData`; sizes flow through `onResize`.

## Integration

```js
import { Terminal } from "@bcwebmux/wgpu-terminal";
import "@bcwebmux/wgpu-terminal/css/terminal.css";
const terminal = new Terminal({
  wasmUrl: "/assets/terminal.wasm",
  font: { cssFamily: "JetBrains Mono Nerd Font", size: 15 },
});
// Full options: index.d.ts. Backend auto (default), webgpu,
// webgl2. Replies arrive on TerminalCore.onReply; copy views.
terminal.onData((bytes) => backend.send(bytes));
terminal.onResize(({ cols, rows }) => backend.resize(cols, rows));
backend.onData((bytes) => terminal.write(bytes));
await terminal.open(document.querySelector("#terminal-container"));
```

Playback-only example (no PTY, needs prepared assets):
[asciinema_playback.html](../example-terminal/asciinema_playback.html).

Compressed input: call `core.resetZstdStream()` when a zstd
stream starts, then `terminal.writeZstd(chunk, length, crc32c)`
per chunk. Each chunk must end on a flush (`ZSTD_e_flush`) and
expand to exactly `length` bytes with that CRC-32C; windows up
to 8 MiB are accepted. `core.decodeZstdFrame` decodes
standalone frames, such as a compressed snapshot.

## Text paths and fonts

`terminal.wasm` holds no fonts. `canvas` (the default) shapes
with the browser, so system fonts supply CJK and emoji; color
emoji render through a dedicated RGBA overlay cache where each
colored glyph keeps its grayscale coverage entry in the main
atlas plus one RGBA overlay entry blended on top. `kb-stb`
shapes and rasterizes the supplied TTFs in WASM; CSS fallbacks
affect only DOM measurement there and color glyphs are
unsupported. Switch with `setRenderer`.

## More than one terminal

Create a core per terminal state; the terminal presents the
attached one while hidden cores keep receiving output. Swap
states with `createCore`, `attachCore`, `restoreSnapshot`.

## Development

- [src/](src/): API, hosting, input, rendering; types in
  [index.d.ts](index.d.ts). WASM engine:
  [../common/terminal/](../common/terminal/).
- Tests live in [../app-bcwebmux/test/](../app-bcwebmux/test/);
  see the [application guide](../app-bcwebmux/README.md#development).
