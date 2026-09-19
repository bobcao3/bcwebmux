// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TerminalCore } from "../../wgpuTerminal/src/TerminalCore.js";

const wasmPath = process.argv[2] ?? new URL("../zig-out/web/terminal.wasm", import.meta.url);
const module = await WebAssembly.compile(await readFile(wasmPath));
const core = new TerminalCore({ renderer: "kb-canvas" });
const imports = core._createWasmImports();
const writes = [];
let replies = "";
let status = 0;
imports.host.clipboard_write = (location, ptr, len) => {
  writes.push({ location, text: new TextDecoder().decode(new Uint8Array(core._wasm.memory.buffer, ptr, len)) });
  return status;
};
imports.host.terminal_reply = (ptr, len) => {
  replies += new TextDecoder().decode(new Uint8Array(core._wasm.memory.buffer, ptr, len));
  return 1;
};
const instance = await WebAssembly.instantiate(module, imports);
core._wasm = instance.exports;
const e = instance.exports;
const osc = (text) => `\x1b]${text}\x1b\\`;
const base64 = (text) => Buffer.from(text).toString("base64");
function kittyWrite({ location = "clipboard", mime = "text/plain", data = base64("hello") } = {}) {
  replies = "";
  core.write(osc(`5522;type=write:loc=${location}:id=test`));
  core.write(osc(`5522;type=wdata:mime=${base64(mime)};${data}`));
  core.write(osc("5522;type=wdata"));
}
function expectStatus(expected) {
  assert.equal(replies, osc(`5522;type=write:status=${expected}:id=test`));
}

e.term_bootstrap();
assert.equal(e.term_init(80, 24), 1);
try {
  core.write(osc(`52;c;${base64("hello é中")}`));
  assert.deepEqual(writes.pop(), { location: 0, text: "hello é中" });
  core.write(osc("52;c;"));
  assert.deepEqual(writes.pop(), { location: 0, text: "" });

  for (const [code, expected] of [[0, "DONE"], [1, "EPERM"], [2, "ENOSYS"], [3, "EBUSY"], [4, "EINVAL"], [5, "EIO"], [99, "EIO"]]) {
    status = code;
    kittyWrite();
    expectStatus(expected);
    assert.deepEqual(writes.pop(), { location: 0, text: "hello" });
  }
  kittyWrite({ location: "primary" });
  expectStatus("ENOSYS");
  kittyWrite({ mime: "text/html" });
  expectStatus("ENOSYS");
  kittyWrite({ data: Buffer.from([0xff]).toString("base64") });
  expectStatus("EINVAL");
  assert.equal(writes.length, 0);

  core.setReplayMode(true);
  core.write(osc(`52;c;${base64("ignored")}`));
  kittyWrite();
  assert.equal(replies, "");
  assert.equal(writes.length, 0);
  core.setReplayMode(false);

  // Query the palette after repeated theme updates and an application override.
  const themePtr = e.term_theme_ptr();
  for (const color of [0x123456, 0xabcdef]) {
    const theme = new Uint32Array(e.memory.buffer, themePtr, 18);
    theme.fill(color);
    assert.equal(e.term_apply_theme(), 1);
    replies = "";
    core.write(osc("4;1;?"));
    const rgb = [16, 8, 0].map(shift => ((color >>> shift) & 255).toString(16).padStart(2, "0").repeat(2)).join("/");
    assert.equal(replies, osc(`4;1;rgb:${rgb}`));
  }
  core.write(osc("4;1;#112233"));
  assert.equal(e.term_apply_theme(), 1);
  replies = "";
  core.write(osc("4;1;?"));
  assert.equal(replies, osc("4;1;rgb:1111/2222/3333"));
  core.write(osc("104;1"));
  replies = "";
  core.write(osc("4;1;?"));
  assert.equal(replies, osc("4;1;rgb:abab/cdcd/efef"));
} finally {
  e.term_deinit();
}
console.log("WASM effects contract passed (clipboard replies, replay suppression, theme palette)");
