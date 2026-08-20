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

## More than one terminal

Create a core for each terminal state and attach the one that should be visible. Cores can keep receiving backend output while another is on screen, and snapshots can be restored before attachment.

```js
const other = await terminal.createCore();
other.write(bytes);
terminal.attachCore(other);
terminal.restoreSnapshot(snapshot, other);
```

`write()` is backend output into the terminal; `onData` is user input. `TerminalCore.onReply` separates parser replies. Callback byte views are borrowed synchronously and must be copied if retained.

Defaults and types are in `index.d.ts`; low-level sources are in `common/terminal`.
