// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// ABI v5 record sizes, shared by browser allocation and submission decoding.
export const CELL_SIZE = 8;
export const STYLE_SIZE = 12;
export const FRAME_SIZE = 80;
export const SUBMISSION_SIZE = 156;
export const CANVAS_REQUEST_SIZE = 24;
export const PATH_COMMAND_SIZE = 28;
export const MAX_PATH_COMMANDS = 1024 * 1024;
export const MAX_RUN_PATH_COMMANDS = 32768;
export const MAX_RUN_PIXELS = 16 * 1024 * 1024;
export const PATH_OP = Object.freeze({ move: 0, line: 1, quadratic: 2, cubic: 3, close: 4 });
