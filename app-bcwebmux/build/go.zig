// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao
const std = @import("std");

pub const GoBuild = struct {
    server: std.Build.LazyPath,
};

pub fn add(b: *std.Build, target: std.Build.ResolvedTarget, optimize: std.lang.Optimize, web_assets: std.Build.LazyPath, core: *std.Build.Step.Compile, zstd: *std.Build.Step.Compile, webp: *std.Build.Step.Compile) GoBuild {
    if (target.result.os.tag != .linux) @panic("Go frontend prototype supports Linux targets");
    const arch = switch (target.result.cpu.arch) {
        .x86_64 => "amd64",
        .aarch64 => "arm64",
        else => @panic("Go frontend supports x86_64 and aarch64 targets"),
    };
    if (!target.result.abi.isMusl() and !target.result.abi.isGnu()) @panic("Go frontend requires a musl or GNU ABI");
    const race = b.option(bool, "go-race", "Enable the Go race detector in gotest (native GNU target)") orelse false;
    if (race and (!target.result.abi.isGnu() or target.result.cpu.arch != b.graph.host.result.cpu.arch)) @panic("-Dgo-race requires a native GNU target");
    const triple = target.query.zigTriple(b.allocator) catch @panic("out of memory");
    const cpu = target.query.serializeCpuAlloc(b.allocator) catch @panic("out of memory");
    const options = b.addOptions();
    options.addOption([]const u8, "zig_exe", b.graph.zig_exe);
    options.addOption([]const u8, "target", triple);
    options.addOption([]const u8, "cpu", cpu);
    const go_amd64 = if (target.result.cpu.arch == .x86_64 and std.Target.x86.featureSetHasAll(
        target.result.cpu.features,
        .{ .cx16, .popcnt, .sahf, .sse3, .ssse3, .sse4_1, .sse4_2 },
    )) "v2" else "v1";
    options.addOption([]const u8, "go_amd64", go_amd64);
    const cc = hostTool(b, "bcwebmux-cc", "toolchains/cc_wrapper.zig");
    cc.root_module.addOptions("config", options);
    const driver = hostTool(b, "bcwebmux-go", "toolchains/go.zig");
    driver.root_module.addOptions("config", options);
    const provision = b.addRunArtifact(hostTool(b, "bcwebmux-provision-go", "toolchains/provision.zig"));
    // Zig displays any successful run's stderr as a "failed command".
    // Save normal download progress, but still report it when the run fails.
    _ = provision.captureStdErr(.{});
    provision.addArg("--manifest");
    provision.addFileArg(b.path("toolchains/go-manifest.json"));
    provision.addArg("--output");
    const toolchain = provision.addOutputDirectoryArg2("go-toolchain", .{});
    // Go requires absolute cache paths; only the path, not its contents, keys the runs.
    const cache = std.Build.LazyPath.cache_root.path(b, "go");

    // Explicit dependency maintenance using the same pinned compiler.
    for ([_][]const u8{ "deps", "fmt" }) |command| {
        const maintenance = b.addRunArtifact(driver);
        _ = maintenance.captureStdErr(.{});
        maintenance.addDirectoryArg2(toolchain, .{});
        maintenance.addArtifactArg2(cc, .{});
        maintenance.addFileArg(b.path("include/bcwebmux.h"));
        maintenance.addFileArg(core.getEmittedBin());
        maintenance.addFileArg(zstd.getEmittedBin());
        maintenance.addFileArg(webp.getEmittedBin());
        maintenance.addArg(arch);
        maintenance.addDirectoryArg2(cache, .{ .make_absolute = true });
        maintenance.addArg(command);
        if (std.mem.eql(u8, command, "fmt")) maintenance.addArg("./...");
        maintenance.setCwd(b.path("go"));
        maintenance.has_side_effects = true;
        b.step(b.fmt("go-{s}", .{command}), if (std.mem.eql(u8, command, "deps")) "Tidy Go dependencies with the pinned toolchain (online)" else "Format first-party Go sources with the pinned toolchain").dependOn(&maintenance.step);
    }

    const stage = b.addWriteFiles();
    _ = stage.addCopyDirectory(b.path("go"), "", .{});
    _ = stage.addCopyDirectory(web_assets, "cmd/bcwebmux-server/web", .{});
    const static = if (target.result.abi.isMusl()) " -extldflags=-static" else "";
    const strip = if (optimize == .small) " -s -w" else "";
    const link_flags = b.fmt("-ldflags=-linkmode=external{s}{s}", .{ static, strip });
    var runs: [2]*std.Build.Step.Run = undefined;
    for (&runs, [_][]const u8{ "build", "test" }) |*slot, command| {
        const run = b.addRunArtifact(driver);
        _ = run.captureStdErr(.{});
        run.addDirectoryArg2(toolchain, .{});
        run.addArtifactArg2(cc, .{});
        run.addFileArg(b.path("include/bcwebmux.h"));
        run.addFileArg(core.getEmittedBin());
        run.addFileArg(zstd.getEmittedBin());
        run.addFileArg(webp.getEmittedBin());
        run.addArg(arch);
        run.addDirectoryArg2(cache, .{ .make_absolute = true });
        run.addArgs(&.{ command, "-trimpath", "-buildvcs=false", "-mod=readonly", link_flags });
        run.setCwd(stage.getDirectory());
        slot.* = run;
    }
    runs[0].addArg("-o");
    const server = runs[0].addOutputFileArg2("bcwebmux-server", .{});
    runs[0].addArg("./cmd/bcwebmux-server");
    if (race) runs[1].addArg("-race");
    const test_step = b.step("gotest", "Run Go tests natively, or compile them for a cross target");
    if (target.result.cpu.arch != b.graph.host.result.cpu.arch or target.result.os.tag != b.graph.host.result.os.tag) {
        runs[1].addArgs(&.{ "-c", "-o" });
        _ = runs[1].addOutputDirectoryArg2("go-tests", .{});
    }
    runs[1].addArg("./...");
    test_step.dependOn(&runs[1].step);
    return .{ .server = server };
}

fn hostTool(b: *std.Build, name: []const u8, source: []const u8) *std.Build.Step.Compile {
    return b.addExecutable(.{ .name = name, .root_module = b.createModule(.{
        .root_source_file = b.path(source),
        .target = b.graph.host,
        .optimize = .safe,
    }) });
}
