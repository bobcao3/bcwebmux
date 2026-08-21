# @bcwebmux/wgpu-terminal

Embeddable WebGPU terminal frontend used by bcwebmux. The package owns terminal emulation, rendering, keyboard/IME input, pointer handling, scrollback, and selection. It does not create a PTY or choose a transport.

```js
import { Terminal } from "@bcwebmux/wgpu-terminal";
import "@bcwebmux/wgpu-terminal/css/terminal.css";

const terminal = new Terminal({
  wasmUrl: "/assets/terminal.wasm",
  renderer: "kb-stb",
  font: {
    cssFamily: "JetBrains Mono Nerd Font",
    size: 15,
    ligatures: true,
    fallbacks: ["ui-monospace", "Noto Emoji", "monospace"],
  },
  theme,
  grainStrength: 4,
});

terminal.onData(bytes => backend.send(bytes));
terminal.onResize(({ cols, rows }) => backend.resize(cols, rows));
backend.onData(bytes => terminal.write(bytes));

await terminal.open(document.querySelector("#terminal-container"));
terminal.focus();
```

## WASM fonts

`terminal.wasm` contains no fonts. The default loader fetches four
`JetBrainsMonoNerdFontMono` TTF files from `fonts/` beside `wasmUrl`, in
regular, bold, italic, and bold-italic order. Fetched face bytes are cached
and shared across cores; each core copies a face into its own linear memory
only when that style is first rendered. The package exports these files under
`@bcwebmux/wgpu-terminal/fonts/*`; consumers may provide a `wasmFontUrls`
array in the same order. CSS `@font-face` declarations should point at the
same URLs so the HTTP cache serves both browser and WASM users.

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

Defaults and types are in `index.d.ts`; low-level sources are in `common/terminal`.
