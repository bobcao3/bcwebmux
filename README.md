# bcwebmux

A fast browser terminal built with Ghostty's terminal engine, WebAssembly with WebGPU and an automatic WebGL2 fallback, and a Go HTTPS server with a Zig session core.

## Get started

- [`bcwebmux/README.md`](bcwebmux/README.md) covers running, configuring, and developing the complete application.
- [`wgpuTerminal/README.md`](wgpuTerminal/README.md) covers building and embedding the standalone terminal.

## What lives where?

This repository contains both a **complete remote-terminal application** and the
**reusable browser terminal it is built on**. They are not the same component:

- [`bcwebmux/`](bcwebmux/) is the complete application, including the browser UI, session management, transport, and Go/native server that runs shells in PTYs.
- [`wgpuTerminal/`](wgpuTerminal/) is the reusable JavaScript terminal frontend with its public API, browser input, selection, scrolling, and rendering. It provides no PTY, server, or transport.
- [`common/terminal/`](common/terminal/) is the low-level WASM engine integrating Ghostty with terminal emulation, font shaping/rasterization, render batches, and shaders.

The browser stack is `bcwebmux/web` → `wgpuTerminal` → `terminal.wasm` built
from `common/terminal`. Separately, the application connects to the Go server →
native Zig session core/PTY worker → shell. The native server also uses Ghostty,
but does not run the browser WASM wrapper.

## Just want something like xterm.js?

Use **[`wgpuTerminal/`](wgpuTerminal/)**, not the complete bcwebmux application.
It fills the embeddable-terminal role; it is **not an xterm.js-compatible drop-in
API**. See the [package README](wgpuTerminal/README.md) for an integration example
and [`index.d.ts`](wgpuTerminal/index.d.ts) for the public API.

## Where do I make a change?

- Application UI and session/reconnect behavior: [`bcwebmux/web/`](bcwebmux/web/); see the [connection lifecycle](bcwebmux/docs/connection-lifecycle.md) documentation.
- HTTP/TLS, WebSockets, and server configuration: [`bcwebmux/go/`](bcwebmux/go/).
- Native sessions, persistence, and PTYs: [`bcwebmux/src/`](bcwebmux/src/).
- Embeddable API, browser input, selection, scrolling, and GPU rendering: [`wgpuTerminal/src/`](wgpuTerminal/src/); API types are in [`index.d.ts`](wgpuTerminal/index.d.ts).
- WASM terminal emulation, fonts, and render data: [`common/terminal/`](common/terminal/); see the [glyph-cache design](docs/glyph_cache_design.md).
- Builds and tests: [`bcwebmux/build.zig`](bcwebmux/build.zig) and [`bcwebmux/test/`](bcwebmux/test/). Tests cover the application and reusable terminal; Go and Zig tests also live alongside their sources.

Edit source directories, not generated `zig-out/`, `wgpuTerminal/dist/`,
dependency caches (`zig-pkg/`, `node_modules/`), or vendored Go dependencies.

## License

This project is licensed under the [MIT License](LICENSE).
