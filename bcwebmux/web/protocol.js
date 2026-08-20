// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const CURRENT_SUBPROTOCOL = "bcw.zstd.v1";
const PROBE_PREFIX = "BCWP:";
const RESIZE_MESSAGE_MAGIC = 0x52574342;
const RESIZE_MESSAGE_LENGTH = 12;

function asUint16(name, value) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw new RangeError(`${name} must be an integer between 0 and 65535`);
  }
  return value;
}

function encodeResize(
  cols,
  rows,
  message = new Uint8Array(RESIZE_MESSAGE_LENGTH),
) {
  if (!(message instanceof Uint8Array) || message.byteLength !== RESIZE_MESSAGE_LENGTH) {
    throw new RangeError(
      `message must be a Uint8Array of exactly ${RESIZE_MESSAGE_LENGTH} bytes`,
    );
  }
  const view = new DataView(message.buffer, message.byteOffset, message.byteLength);
  view.setUint32(0, RESIZE_MESSAGE_MAGIC, true);
  view.setUint16(4, asUint16("cols", cols), true);
  view.setUint16(6, asUint16("rows", rows), true);
  return message;
}

export {
  CURRENT_SUBPROTOCOL,
  PROBE_PREFIX,
  RESIZE_MESSAGE_MAGIC,
  RESIZE_MESSAGE_LENGTH,
  encodeResize,
};
