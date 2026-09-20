// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const ghostty = @import("ghostty-vt");

// The build requests +kitty-graphics. Probe the effective public API rather
// than assuming the requested feature survives upstream target restrictions.
export fn kitty_graphics_available() u32 {
    return @intFromBool(@hasDecl(@FieldType(ghostty.Screen, "kitty_images"), "addPendingImage"));
}
