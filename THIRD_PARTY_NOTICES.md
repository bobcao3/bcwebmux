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
- **License text:**
  [app-bcwebmux/web/fonts/OFL.txt](app-bcwebmux/web/fonts/OFL.txt), also
  installed to `zig-out/wgpu-terminal/fonts/OFL.txt`.

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

Downloaded using `app-bcwebmux/go/go.mod` and `go.sum`, then linked into
`bcwebmux-server`. The license links below identify the pinned module versions:

| Module                                | License      | Copyright                                                                   | License text                                                                   |
| ------------------------------------- | ------------ | --------------------------------------------------------------------------- | ------------------------------------------------------------------------------ |
| `github.com/BurntSushi/toml`          | MIT          | Copyright (c) 2013 TOML authors                                             | <https://pkg.go.dev/github.com/BurntSushi/toml@v1.5.0?tab=licenses>            |
| `github.com/fxamacker/cbor/v2`        | MIT          | Copyright (c) 2019-present Faye Amacker                                     | <https://pkg.go.dev/github.com/fxamacker/cbor/v2@v2.9.4?tab=licenses>          |
| `github.com/go-viper/mapstructure/v2` | MIT          | Copyright (c) 2013 Mitchell Hashimoto                                       | <https://pkg.go.dev/github.com/go-viper/mapstructure/v2@v2.5.0?tab=licenses>   |
| `github.com/go-webauthn/webauthn`     | BSD 3-Clause | Copyright (c) 2025 github.com/go-webauthn/webauthn authors                  | <https://pkg.go.dev/github.com/go-webauthn/webauthn@v0.18.2?tab=licenses>      |
| `github.com/go-webauthn/x`            | BSD 3-Clause | Copyright (c) 2021-2023 github.com/go-webauthn authors                      | <https://pkg.go.dev/github.com/go-webauthn/x@v0.3.1?tab=licenses>              |
| `github.com/golang-jwt/jwt/v5`        | MIT          | Copyright (c) 2012 Dave Grijalva, 2021 golang-jwt maintainers               | <https://pkg.go.dev/github.com/golang-jwt/jwt/v5@v5.3.1?tab=licenses>          |
| `github.com/google/go-tpm`            | Apache-2.0   | Copyright 2018 Google Inc.                                                  | <https://pkg.go.dev/github.com/google/go-tpm@v0.9.8?tab=licenses>              |
| `github.com/google/uuid`              | BSD 3-Clause | Copyright (c) 2009,2014 Google Inc. All rights reserved.                    | <https://pkg.go.dev/github.com/google/uuid@v1.6.0?tab=licenses>                |
| `github.com/gorilla/websocket`        | BSD 2-Clause | Copyright (c) 2013 The Gorilla WebSocket Authors                            | <https://pkg.go.dev/github.com/gorilla/websocket@v1.5.3?tab=licenses>          |
| `github.com/philhofer/fwd`            | MIT          | Copyright (c) 2014-2015 Philip Hofer                                        | <https://pkg.go.dev/github.com/philhofer/fwd@v1.2.0?tab=licenses>              |
| `github.com/quic-go/quic-go`          | MIT          | Copyright (c) 2016 the quic-go authors & Google, Inc.                       | <https://pkg.go.dev/github.com/quic-go/quic-go@v0.62.0?tab=licenses>           |
| `github.com/quic-go/qpack`            | MIT          | Copyright 2019 Marten Seemann                                               | <https://pkg.go.dev/github.com/quic-go/qpack@v0.6.0?tab=licenses>              |
| `github.com/tinylib/msgp`             | MIT          | Copyright (c) 2014 Philip Hofer; portions Copyright (c) 2009 The Go Authors | <https://pkg.go.dev/github.com/tinylib/msgp@v1.6.4?tab=licenses>               |
| `github.com/x448/float16`             | MIT          | Copyright (c) 2019 Montgomery Edwards⁴⁴⁸ and Faye Amacker                   | <https://pkg.go.dev/github.com/x448/float16@v0.8.4?tab=licenses>               |
| `rsc.io/qr`                           | BSD 3-Clause | Copyright (c) 2009 The Go Authors                                           | <https://pkg.go.dev/rsc.io/qr@v0.2.0?tab=licenses>                             |
| `golang.org/x/crypto`                 | BSD 3-Clause | Copyright 2009 The Go Authors                                               | <https://pkg.go.dev/golang.org/x/crypto@v0.57.0?tab=licenses> (plus `PATENTS`) |
| `golang.org/x/net`                    | BSD 3-Clause | Copyright 2009 The Go Authors                                               | <https://pkg.go.dev/golang.org/x/net@v0.58.0?tab=licenses> (plus `PATENTS`)    |
| `golang.org/x/sys`                    | BSD 3-Clause | Copyright 2009 The Go Authors                                               | <https://pkg.go.dev/golang.org/x/sys@v0.48.0?tab=licenses> (plus `PATENTS`)    |
| `golang.org/x/text`                   | BSD 3-Clause | Copyright 2009 The Go Authors                                               | <https://pkg.go.dev/golang.org/x/text@v0.42.0?tab=licenses> (plus `PATENTS`)   |

The module archives downloaded into Go's module cache contain their license
texts. Redistributors must include those texts with the built artifacts; they
are no longer present in this repository's source tree.

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
links to and fetches the asciinema recording <https://asciinema.org/a/664965> in
the browser. The recording is not redistributed here; its terms are those of its
author and asciinema.org.
