// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

// One native test root avoids running transitive Session/protocol tests once
// per importing module and includes the C transport queue ownership checks.
test {
    _ = @import("protocol.zig");
    _ = @import("vfs.zig");
    _ = @import("Session.zig");
    _ = @import("SessionRegistry.zig");
    _ = @import("c_api.zig");
}
