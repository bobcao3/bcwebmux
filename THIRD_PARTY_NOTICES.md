# Third-party notices

First-party code in this repository — everything under `app-bcwebmux/`,
`wgpuTerminal/`, `common/`, `example-terminal/`, `docs/`, and the build files at
the repository root — is licensed under the [MIT License](LICENSE).

This file lists the third-party components that this repository vendors, fetches
at build time, or compiles into the artifacts it produces, together with the
license that applies to each and where its license text lives. The list was
derived from `app-bcwebmux/build.zig.zon`, the root `package.json` and
`app-bcwebmux/package.json`, `app-bcwebmux/go/go.mod`, and the contents of built
artifacts.

If you redistribute build outputs (`bcwebmux-server`, `bcwebmux-worker`,
`terminal.wasm`, or the served web assets), ship this file and the license texts
it points to alongside them.

## Compiled into the produced artifacts

### Ghostty

- **License:** MIT
- **Copyright:** Copyright (c) 2024 Mitchell Hashimoto, Ghostty contributors
- **Used as:** the `ghostty-vt` module and `libghostty-vt` static library, built
  from the `bobcao3/ghostty` fork pinned in `app-bcwebmux/build.zig.zon`, and
  compiled into both `terminal.wasm` and the native `bcwebmux_core` library.
- **License text:** ships in the fetched package as `zig-pkg/ghostty-*/LICENSE`.
  Upstream: <https://github.com/ghostty-org/ghostty>.

### Ghostty's bundled dependencies that reach these artifacts

Ghostty vendors a number of third-party libraries in its own tree and fetches
others as Zig packages. Only those reachable from the `libghostty-vt` feature
sets this project enables are built here:

- **Wuffs** (Wrangling Untrusted File Formats Safely) — MIT **or** Apache-2.0 —
  Copyright (c) 2017 The Wuffs Authors. Vendored by Ghostty at `pkg/wuffs`;
  compiled into the native server (PNG/JPEG image decode for Kitty graphics).
- **zlib** — Zlib license — Copyright (C) 1995-2022 Jean-loup Gailly and Mark
  Adler. Vendored by Ghostty at `pkg/zlib`; compiled into the native server.
- **uucode** (µUnicode) — MIT — Copyright (c) 2026 Jacob Sandlund. Supplies the
  Unicode tables used by `libghostty-vt` on both targets.

License texts for these ship inside the fetched Ghostty package and in Ghostty's
own repository. Libraries that Ghostty vendors only for its own application
(GTK/macOS front ends, font stack, shader tooling, and so on) are not part of
this project's build and are not distributed here.

### kb

- **License:** zlib license
- **Copyright:** (C) Copyright 2024-2025 Jimmy Lefevre
- **Used as:** `kb_text_shape.h` font shaping, built from source declared in
  `app-bcwebmux/build.zig.zon`; compiled into `terminal.wasm` only, as the
  browser terminal's shaping backend.
- **License text:** ships in the fetched package as `zig-pkg/N-V-*/LICENSE`.

### stb (stb_truetype.h)

- **License:** public domain (Unlicense), with the MIT License as a documented
  alternative
- **Copyright:** narrow waivers only; see the header for the exact statements
- **Used as:** `stb_truetype.h` rasterization, declared in
  `app-bcwebmux/build.zig.zon` and compiled into `terminal.wasm` only, as the
  browser terminal's rasterization backend. The dual statement is in the
  header's comment block.

### zstd

- **License:** BSD 3-Clause
- **Copyright:** Copyright (c) Meta Platforms, Inc. and affiliates. All rights
  reserved.
- **Used as:** pinned v1.5.7 in `app-bcwebmux/build.zig.zon`, linked into
  `bcwebmux-server` by `app-bcwebmux/build/zstd.zig`.
- **License text:** ships in the fetched package as `zig-pkg/N-V-*/LICENSE`.

### JetBrains Mono Nerd Font

- **License:** SIL Open Font License 1.1
- **Copyright:** Copyright 2020 The JetBrains Mono Project Authors
- **Used as:** the served terminal font (`JetBrainsMonoNerdFontMono-*.ttf`),
  fetched from the pinned `nerd-fonts` release in `app-bcwebmux/build.zig.zon`.
- **License text:** [app-bcwebmux/web/fonts/OFL.txt](app-bcwebmux/web/fonts/OFL.txt),
  also installed to `zig-out/wgpu-terminal/fonts/OFL.txt`.

### Noto Emoji

- **License:** SIL Open Font License 1.1
- **Copyright:** Copyright 2013 Google LLC
- **Used as:** the served emoji fallback font (`fonts/NotoEmoji-Regular.woff2`,
  copied from the `@fontsource/noto-emoji` 5.3.0 npm package).
- **License text:**
  [app-bcwebmux/web/fonts/NotoEmoji-OFL.txt](app-bcwebmux/web/fonts/NotoEmoji-OFL.txt),
  which is also served next to the font.

### fzstd

- **License:** MIT
- **Copyright:** Copyright (c) 2020 Arjun Barrett
- **Used as:** the browser-side zstd decompressor, copied into the served assets
  as `fzstd.js` from the `fzstd` npm package.
- **License text:** `node_modules/fzstd/LICENSE` (installed by `npm install`).

### Go dependencies

Vendored in-tree under `app-bcwebmux/go/vendor/` and linked into
`bcwebmux-server`:

| Module | License | Copyright | License text |
| --- | --- | --- | --- |
| `github.com/BurntSushi/toml` | MIT | Copyright (c) 2013 TOML authors | `vendor/github.com/BurntSushi/toml/COPYING` |
| `github.com/gorilla/websocket` | BSD 2-Clause | Copyright (c) 2013 The Gorilla WebSocket Authors | `vendor/github.com/gorilla/websocket/LICENSE` |
| `github.com/quic-go/quic-go` | MIT | Copyright (c) 2016 the quic-go authors & Google, Inc. | `vendor/github.com/quic-go/quic-go/LICENSE` |
| `github.com/quic-go/qpack` | MIT | Copyright 2019 Marten Seemann | `vendor/github.com/quic-go/qpack/LICENSE.md` |
| `golang.org/x/crypto` | BSD 3-Clause | Copyright 2009 The Go Authors | `vendor/golang.org/x/crypto/LICENSE` (plus `PATENTS`) |
| `golang.org/x/net` | BSD 3-Clause | Copyright 2009 The Go Authors | `vendor/golang.org/x/net/LICENSE` (plus `PATENTS`) |
| `golang.org/x/sys` | BSD 3-Clause | Copyright 2009 The Go Authors | `vendor/golang.org/x/sys/LICENSE` (plus `PATENTS`) |
| `golang.org/x/text` | BSD 3-Clause | Copyright 2009 The Go Authors | `vendor/golang.org/x/text/LICENSE` (plus `PATENTS`) |

Paths are relative to `app-bcwebmux/go/`. Because these modules are vendored, the
required notice texts are already part of this repository's source tree.

## Fetched at build time, not redistributed

These are used to build or test but are neither committed to this repository nor
included in the artifacts:

- **Zig toolchain** (0.16.0) and **Go toolchain** (pinned by
  `app-bcwebmux/toolchains/go-manifest.json`), downloaded by the build.
- **Ghostty build helpers** `aro` (MIT, Copyright (c) 2021 Veikka Tuominen) and
  `translate_c`.
- **npm dependencies** — `npm install` resolves the workspace packages plus
  `@fontsource/noto-emoji` and `fzstd` (both covered above) and the
  build/test-only `sharp` (Apache-2.0) and its transitive dependencies.
- **Chromium** and **OpenSSL**, used by the browser and HTTPS test suites.

## Referenced at runtime

[`example-terminal/asciinema_playback.html`](example-terminal/asciinema_playback.html)
links to and fetches the asciinema recording
<https://asciinema.org/a/664965> in the browser. The recording is not
redistributed here; its terms are those of its author and asciinema.org.
