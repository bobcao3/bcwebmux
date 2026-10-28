# bcwebmux

A fast remote terminal: shells run in PTYs on your server and
reach any browser with persistent sessions, reconnect, GPU
rendering, and a reusable terminal frontend.

## Run it

```sh
# From the repository root
npm install
cd app-bcwebmux && zig build -Doptimize=small
./zig-out/bin/bcwebmux-sessiond &
./zig-out/bin/bcwebmux-server --origin http://localhost:8080
```

The session daemon must stay running when the web server restarts. Open
http://localhost:8080. Needs Linux, Zig 0.17.0, Node/npm,
network. Factorless servers are open to the network:
enroll before exposing ([application guide](app-bcwebmux/README.md)).

## Which piece do I need?

- [app-bcwebmux/](app-bcwebmux/): the complete application.
- [wgpuTerminal/](wgpuTerminal/): the reusable terminal for your
  own page. It is **not an xterm.js-compatible drop-in API**.
- [example-terminal/](example-terminal/): single-file playback
  demo; serve the root, prepare WASM assets, and open the
  [playback page](example-terminal/asciinema_playback.html).

## Where do I make a change?

UI in [app-bcwebmux/web/](app-bcwebmux/web/), server in
[app-bcwebmux/go/](app-bcwebmux/go/), sessions in
[app-bcwebmux/src/](app-bcwebmux/src/), terminal API in
[wgpuTerminal/src/](wgpuTerminal/src/), WASM engine in
[common/terminal/](common/terminal/).

## Status and non-goals

Usable application; private terminal workspace (unpublished);
Kitty graphics are a static subset; no offline PWA
([docs/](docs/README.md)).

## License

First-party code is MIT ([LICENSE](LICENSE)); redistributions
ship [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md) and the
license texts it points to.
