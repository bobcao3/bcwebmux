// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// ABI v7 record sizes, shared by browser allocation and submission decoding.
export const CELL_SIZE = 8;
export const STYLE_SIZE = 12;
export const FRAME_SIZE = 80;
export const SUBMISSION_SIZE = 156;
export const GRAPHICS_RESOURCE_SIZE = 44;
export const GRAPHICS_DRAW_SIZE = 48;
export const CANVAS_REQUEST_SIZE = 24;
export const CANVAS_TEXT_UNIT_SIZE = 1;
export const MAX_RUN_CODEPOINTS = 32;
export const MAX_RUN_TEXT_BYTES = MAX_RUN_CODEPOINTS * 4;
export const MAX_RUN_PIXELS = 16 * 1024 * 1024;
