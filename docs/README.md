# Documentation

All first-party architecture, behavior, and design documents live in this
repository-root `docs/` directory.

## Topics

- [Connection lifecycle](connection-lifecycle.md): connection ownership,
  liveness, recovery, backpressure, and replay contracts.
- [Glyph cache design](glyph-cache-design.md): cell-sized glyph slots, shared
  atlas ownership, capacity limits, and terminal partitions.
- [Kitty graphics design](kitty-graphics.md): local Ghostty checkout,
  WASM portability, checkpoint continuation and browser rendering;
  compilation alone does not complete image support.

## Component guides

- [Repository overview](../README.md)
- [Application setup, configuration, and development](../app-bcwebmux/README.md)
- [Terminal package build, embedding, and API usage](../wgpuTerminal/README.md)

## Storage conventions

- Add topic documents here, not in component-local `docs/` directories.
- Use descriptive lowercase, hyphen-separated filenames, such as
  `connection-lifecycle.md`.
- Keep the root and component `README.md` files as entry points for setup and
  usage; link to topic documents rather than duplicating them.
- List new topic documents in this index and label proposals as proposals.
- Use relative Markdown links resolved from the containing document. When
  describing source paths in prose or code, use repository-root-relative paths
  unless another base is explicitly stated.
- Keep vendored documentation, license notices, generated files, and dependency
  caches in their existing locations; they are not part of this docs index.
