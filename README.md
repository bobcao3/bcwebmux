# bcwebmux

A fast browser terminal built with Ghostty's terminal engine, WebAssembly, WebGPU, and a small Zig server.

## Get started

Prerequisites: Zig 0.16, Node/npm, GNU tar, zstd and development headers, `woff2_compress`, Linux, and WebGPU-capable Chromium.

```sh
npm install
cd bcwebmux
zig build -Doptimize=ReleaseSmall
./zig-out/bin/bcwebmux-server
```

Open <http://localhost:8080>. Use `--help` for server options. Remote use should sit behind authenticated TLS and requires explicit host/origin options.

## Find your way around

- [`common/`](common/) — shared Zig terminal code
- [`wgpuTerminal/`](wgpuTerminal/) — embeddable package; see its [README](wgpuTerminal/README.md)
- [`bcwebmux/`](bcwebmux/) — application, server, assets, and tests

## Develop

From `bcwebmux/`:

```sh
zig build
zig build test
zig build e2e
```

Browser tests require a physical Vulkan GPU. Intentional golden updates use `UPDATE_GOLDEN=1 zig build e2e`.

## License

This project is licensed under the [MIT License](LICENSE).
