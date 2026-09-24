// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { TerminalCore } from "../../wgpuTerminal/src/TerminalCore.js";

const fixture = `
38;2;96;96;96mX 38;44f 38;2;106;24;109mX 38;2;115;44;118mX
38;2;125;65;128mX 38;2;155;100;158mX 38;2;187;137;190mX 38;2;220;175;222mX
38;2;135;208;160mX 38;2;133;208;161mX 38;2;137;208;159mX 38;2;200;200;200mX
38;2;126;203;160mX 38;2;126;205;161mX 38;2;195;195;195mX 38;2;124;199;157mX
38;2;127;206;162mX 38;2;190;190;190mX 38;2;121;193;153mX 38;2;122;195;154mX
38;2;119;187;149mX 38;2;122;196;155mX 38;2;185;185;185mX 38;2;117;183;146mX
38;2;181;181;181mX 38;2;120;190;151mX 38;2;114;177;142mX 38;2;169;169;169mX
38;2;112;172;138mX 38;2;113;176;141mX 38;2;110;167;135mX 38;2;165;165;165mX
38;2;113;174;140mX 38;2;160;160;160mX 38;2;107;161;131mX 38;2;117;184;147mX
38;2;155;155;155mX 38;2;105;157;128mX 38;2;150;150;150mX 38;2;103;151;124mX
38;2;101;147;121mX 38;2;146;146;146mX 38;2;102;150;123mX 38;2;140;140;140mX
38;2;98;141;117mX 38;2;100;146;120mX 38;2;134;134;134mX 38;2;96;136;113mX
38;2;130;130;130mX 38;2;94;131;110mX 38;2;125;125;125mX 38;2;91;125;106mX
38;2;120;120;120mX 38;2;89;121;103mX 38;2;115;115;115mX 38;2;87;115;99mX
38;2;85;111;96mX 38;2;111;111;111mX 38;2;88;120;102mX 38;2;105;105;105mX
38;2;82;105;92mX 38;2;83;107;93mX 38;2;99;99;99mX 38;2;80;100;88mX
38;2;81;102;90mX 38;2;95;95;95mX 38;2;75;89;81mX 38;2;90;90;90mX
38;2;78;95;85mX 38;2;85;85;85mX 38;2;73;85;78mX 38;2;72;84;77mX
38;2;80;80;80mX 38;2;71;79;74mX 38;2;204;204;204mX 38;2;69;75;71mX
38;2;76;76;76mX 38;2;70;78;73mX 38;2;70;70;70mX 38;2;66;69;67mX
1mX 38;2;85;109;89mX 38;2;167;197;128mX 38;2;144;199;141mX 48;2;0;0;0mX
38;2;166;197;129mX 38;2;189;194;116mX 38;2;205;176;104mX 38;2;210;144;95mX
38;2;214;111;86mX 38;2;220;76;76mX 38;2;96;96;96mX 9;91f 38;2;204;204;204mX
22mX 38;2;64;64;64mX 38;2;177;195;123mX 38;2;137;200;145mX 38;2;127;201;151mX
38;2;161;197;132mX 38;2;154;198;136mX 38;2;152;198;137mX 38;2;145;199;140mX
38;2;135;200;146mX 38;2;119;202;155mX 38;2;48;48;48mX 10;91f 38;2;140;200;143m
9;123f 38;2;129;201;150m
`.trim().split(/\s+/).map(sequence => `\x1b[${sequence}`).join("");

const wasmPath = process.argv[2] ?? new URL("../zig-out/web/terminal.wasm", import.meta.url);
const module = await WebAssembly.compile(await readFile(wasmPath));
const bytes = new TextEncoder().encode(fixture);

// Exercise the JS host bridge and Zig logger with whole-buffer and bytewise input.
for (const chunkSize of [bytes.length, 1]) {
  const core = new TerminalCore({ renderer: "canvas" });
  const instance = await WebAssembly.instantiate(module, core._createWasmImports());
  core._wasm = instance.exports;
  const e = instance.exports;
  const logs = [];
  const original = Object.fromEntries(["error", "warn", "info", "debug", "log"].map(method => [method, console[method]]));
  for (const method of Object.keys(original)) console[method] = (...args) => logs.push({ method, args });
  try {
    e.term_bootstrap();
    assert.equal(e.term_init(155, 47), 1);
    assert.equal(e.term_resize_canonical(155, 47, 9, 18), 1);
    for (let offset = 0; offset < bytes.length; offset += chunkSize) core.write(bytes.subarray(offset, offset + chunkSize));
    assert.ok(logs.some(entry => entry.method === "info" && entry.args[0] === "terminal WASM:" && entry.args[1].includes("(page_list): adjusting page capacity=")), "page adjustment diagnostic must reach the host, not be suppressed");
    for (const entry of logs) assert.ok(new TextEncoder().encode(entry.args[1]).length <= 2048);

    core.write("\x1b[0m\x1b[HOK");
    assert.equal(e.term_selection_set_range(0, 0, 0, 2), 1);
    assert.equal(core.getSelection(), "OK", "terminal continues parsing after its diagnostic");
  } finally {
    Object.assign(console, original);
    e.term_deinit();
  }
}
console.log("WASM logging regression passed (sanitized btop; whole-buffer and bytewise)");
