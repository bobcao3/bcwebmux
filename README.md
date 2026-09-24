# bcwebmux

A fast browser terminal built with Ghostty's terminal engine, WebAssembly with WebGPU and an automatic WebGL2 fallback, and a Go HTTPS server with a Zig session core.

## Get started

- [`app-bcwebmux/README.md`](app-bcwebmux/README.md) covers running, configuring, and developing the complete application.
- [`wgpuTerminal/README.md`](wgpuTerminal/README.md) covers building and embedding the standalone terminal.
- [`example-terminal/asciinema_playback.html`](example-terminal/asciinema_playback.html) demonstrates standalone PTY recording playback. Serve the repository root with `python3 -m http.server 8000` and open `http://localhost:8000/example-terminal/asciinema_playback.html` (prepare WASM assets first with `node wgpuTerminal/scripts/prepare-wasm.mjs` if needed).

Architecture, behavior, and design documents live in the repository-root
[`docs/`](docs/README.md). Component READMEs stay beside their code.

## What lives where?

This repository contains both a **complete remote-terminal application** and the
**reusable browser terminal it is built on**. They are not the same component:

- [`app-bcwebmux/`](app-bcwebmux/) is the complete application, including the browser UI, session management, transport, and Go/native server that runs shells in PTYs.
- [`wgpuTerminal/`](wgpuTerminal/) is the reusable JavaScript terminal frontend with its public API, browser input, selection, scrolling, and rendering. It provides no PTY, server, or transport.
- [`example-terminal/`](example-terminal/) is a single-HTML playback example using the reusable terminal to play [asciinema #664965](https://asciinema.org/a/664965).
- [`common/terminal/`](common/terminal/) is the low-level WASM engine integrating Ghostty with terminal emulation, font shaping/rasterization, render batches, and shaders.

The browser stack is `app-bcwebmux/web` → `wgpuTerminal` → `terminal.wasm` built
from `common/terminal`. Separately, the application connects to the Go server →
native Zig session core/PTY worker → shell. The native server also uses Ghostty,
but does not run the browser WASM wrapper.

## Just want something like xterm.js?

Use **[`wgpuTerminal/`](wgpuTerminal/)**, not the complete bcwebmux application.
It fills the embeddable-terminal role; it is **not an xterm.js-compatible drop-in
API**. See the [package README](wgpuTerminal/README.md) for an integration example
and [`index.d.ts`](wgpuTerminal/index.d.ts) for the public API.

## Where do I make a change?

- Application UI and session/reconnect behavior: [`app-bcwebmux/web/`](app-bcwebmux/web/); see the [connection lifecycle](docs/connection-lifecycle.md) documentation.
- HTTP/TLS, WebSockets, and server configuration: [`app-bcwebmux/go/`](app-bcwebmux/go/).
- Native sessions, persistence, and PTYs: [`app-bcwebmux/src/`](app-bcwebmux/src/).
- Embeddable API, browser input, selection, scrolling, and GPU rendering: [`wgpuTerminal/src/`](wgpuTerminal/src/); API types are in [`index.d.ts`](wgpuTerminal/index.d.ts).
- WASM terminal emulation, fonts, and render data: [`common/terminal/`](common/terminal/); see the [glyph-cache design](docs/glyph-cache-design.md).
- Builds and tests: [`app-bcwebmux/build.zig`](app-bcwebmux/build.zig) and [`app-bcwebmux/test/`](app-bcwebmux/test/). Tests cover the application and reusable terminal; Go and Zig tests also live alongside their sources.

Edit source directories, not generated `zig-out/`, `wgpuTerminal/dist/`,
dependency caches (`zig-pkg/`, `node_modules/`), or vendored Go dependencies.

## License

This project is licensed under the [MIT License](LICENSE).
