import assert from "node:assert/strict";
import { FramePresenter } from "../../wgpuTerminal/src/browser/render/FramePresenter.js";

const operations = [];
let fail = false;
const core = {
  invalidations: 0,
  options: { font: {} },
  invalidateFrame() { this.invalidations++; },
  consumeFrame(fn) { fn(packet); return 1; },
};
const packet = {
  fullFrame: true, revision: 1, cols: 2, rows: 1, frameCells: 2,
  bitmapUploadsCount: 1, bitmapUploads: new DataView(new Uint32Array([0, 1, 0, 2]).buffer),
  bitmapUploadPixels: new Uint8Array(2), canvasRequestsCount: 1,
  canvasRequests: new DataView(new Uint32Array([1, 1, 1, 0, 1, 0]).buffer),
  canvasText: new TextEncoder().encode("a"),
  stylesFirst: 0, styles: new Uint32Array(3), styleBytes: new Uint8Array(12),
  dirtyRangesCount: 1, dirtyRanges: new DataView(new Uint32Array([0, 1]).buffer),
  cells: new Uint8Array(16), selections: new Uint32Array(1),
};
const backend = {
  initialized: true, activeTerminal: core, cellSize: 8, styleSize: 12, atlas: {}, submissionMetadata: {},
  glyphPartitions: new Map([[core, {}]]),
  uploadBitmap(...args) { operations.push(args[0] === 0 ? "bitmap" : "canvas"); },
  uploadStyles() { operations.push("styles"); if (fail) throw Error("upload failed"); },
  uploadCells(first, count, cells, selections) {
    operations.push("cells");
    assert.deepEqual([first, count, cells.length, selections.length], [0, 1, 16, 1]);
  },
  presentCurrentState() { operations.push("present"); },
};
const presenter = new FramePresenter({
  _textView: { update() { operations.push("text"); } },
  _submitFrameMetadata() { operations.push("metadata"); },
}, backend);
presenter.canvasRasterizer = {
  rasterize(first, slots, span, text, offset, count, style, atlas, font, upload) {
    assert.deepEqual([first, slots, span, offset, count], [1, 1, 1, 0, 1]);
    assert.equal(text, packet.canvasText);
    assert.equal(style, 0);
    assert.equal(font, core.options.font);
    assert.equal(atlas, backend.atlas);
    upload(first, slots, new Uint8Array(2), 0, 2);
  },
};
presenter.consumeFrame(core);
assert.ok(!operations.includes("present"), "consuming never presents");
presenter.present();
assert.deepEqual(operations, ["bitmap", "canvas", "styles", "cells", "text", "metadata", "present"]);
assert.equal(presenter.revision, 1);
operations.length = 0;
fail = true;
packet.fullFrame = false;
assert.throws(() => presenter.consumeFrame(core), /upload failed/);
assert.equal(presenter.present(), false);
assert.deepEqual(operations, ["bitmap", "canvas", "styles"]);
assert.equal(presenter.revision, null);
fail = false;
operations.length = 0;
assert.throws(() => presenter.consumeFrame(core), /full replacement/);
assert.deepEqual(operations, []);
packet.fullFrame = true;
packet.revision++;
presenter.consumeFrame(core);
assert.equal(presenter.valid, true);
assert.equal(backend.error, null);
assert.equal(operations.at(-1), "metadata");
presenter.present();
assert.equal(operations.at(-1), "present");
console.log("frame presenter contract passed");
