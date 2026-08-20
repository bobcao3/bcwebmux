// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

import assert from "node:assert/strict";
import {
  CURRENT_SUBPROTOCOL,
  PROBE_PREFIX,
  RESIZE_MESSAGE_LENGTH,
  RESIZE_MESSAGE_MAGIC,
  encodeResize,
} from "../web/protocol.js";

assert.equal(CURRENT_SUBPROTOCOL, "bcw.zstd.v1");
assert.equal(PROBE_PREFIX, "BCWP:");
assert.equal(RESIZE_MESSAGE_MAGIC, 0x52574342);
assert.equal(RESIZE_MESSAGE_LENGTH, 12);
assert.deepEqual(
  [...encodeResize(80, 24)],
  [0x42, 0x43, 0x57, 0x52, 0x50, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00],
);
const reused = new Uint8Array(12);
const encoded = encodeResize(80, 24, reused);
assert.strictEqual(encoded, reused);
assert.deepEqual(
  [...encoded],
  [0x42, 0x43, 0x57, 0x52, 0x50, 0x00, 0x18, 0x00, 0x00, 0x00, 0x00, 0x00],
);
assert.throws(() => encodeResize(-1, 24), RangeError);
assert.throws(() => encodeResize(80, 0x10000), RangeError);
