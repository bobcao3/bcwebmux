// SPDX-License-Identifier: MIT
import assert from "node:assert/strict";
import { readFile, readdir } from "node:fs/promises";
import { Terminal } from "../../wgpuTerminal/src/Terminal.js";
import { PointerController } from "../../wgpuTerminal/src/browser/input/PointerController.js";

const root = new URL("../../wgpuTerminal/src/", import.meta.url);
for (const path of [
  "browser/ViewportController.js",
  "browser/input/PointerController.js",
  "browser/input/InputController.js",
]) {
  assert.doesNotMatch(
    await readFile(new URL(path, root), "utf8"),
    /getCore|TerminalCore|\.term_|\._wasm/,
  );
}
async function inspect(dir) {
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const url = new URL(entry.name + (entry.isDirectory() ? "/" : ""), dir);
    if (entry.isDirectory()) await inspect(url);
    else if (entry.name.endsWith(".js")) {
      const source = await readFile(url, "utf8");
      if (!["TerminalCore.js", "FramePacket.js"].includes(entry.name))
        assert.doesNotMatch(source, /\.memory\.buffer|instance\.exports|\._wasm\b/);
      if (/\/(webgpu|webgl)\//.test(url.pathname))
        assert.doesNotMatch(
          source,
          /requestAnimationFrame|setInterval|_scheduler|submissionMetadata/,
        );
    }
  }
}
await inspect(root);
assert.match(
  await readFile(new URL("browser/render/CanvasAlphaMask.js", root), "utf8"),
  /fillText/,
);
assert.doesNotMatch(
  await readFile(new URL("browser/render/CanvasAlphaMask.js", root), "utf8"),
  /validateCanvasPath|PATH_OP/,
);
assert.throws(() => new Terminal({ powerPreference: "turbo" }), /power preference/);
assert.equal(new Terminal().options.powerPreference, undefined);
const pointer = Object.create(PointerController.prototype);
pointer.getMetrics = () => ({ scaleX: 2, scaleY: 3 });
pointer.surface = { getBoundingClientRect: () => ({ left: 10, top: 20 }) };
let mouse;
pointer.mouse = (...args) => {
  mouse = args;
  return true;
};
assert.equal(pointer.sendMouse({ clientX: 14, clientY: 25, buttons: 1 }, "press", "left"), true);
assert.deepEqual(mouse, [
  "press",
  "left",
  { shiftKey: false, altKey: false, ctrlKey: false, metaKey: false },
  8,
  15,
  true,
]);
console.log("renderer integration contract passed (module layering, power hint, pointer scaling)");
