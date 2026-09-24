// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const go_build = @import("build/go.zig");
const zstd_build = @import("build/zstd.zig");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{ .default_target = .{ .os_tag = .linux, .abi = .musl, .cpu_model = .baseline } });
    const runnable_target = target.result.cpu.arch == b.graph.host.result.cpu.arch and target.result.os.tag == b.graph.host.result.os.tag;
    const optimize = b.standardOptimizeOption(.{});
    const test_filters = b.option([][]const u8, "test-filter", "Filter Zig tests") orelse &[0][]const u8{};
    const wasm_optimize = b.option(std.builtin.OptimizeMode, "wasm-optimize", "Optimization mode for WebAssembly") orelse .ReleaseSmall;

    var wasm_query = std.Target.Query{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    };
    wasm_query.cpu_features_add.addFeature(@intFromEnum(std.Target.wasm.Feature.simd128));
    const wasm_target = b.resolveTargetQuery(wasm_query);
    const kb = b.dependency("kb", .{ .target = wasm_target, .optimize = wasm_optimize });
    const stb = b.dependency("stb", .{ .target = wasm_target, .optimize = wasm_optimize });
    const zstd_dep = b.dependency("zstd", .{});
    const jetbrains_mono_nerd_font = b.dependency("jetbrains_mono_nerd_font", .{});
    const terminal_font_styles = [_][]const u8{ "Regular", "Bold", "Italic", "BoldItalic" };
    const ghostty = b.dependency("ghostty", .{
        .target = wasm_target,
        .optimize = wasm_optimize,
        .simd = false,
        .@"emit-lib-vt" = true,
        .@"vt-features" = "-all,+render-state,+input-encode,+selection,+snapshot,+kitty-graphics",
    });
    // The headless server is latency-sensitive; Debug Ghostty makes output-heavy apps unusably slow.
    const server_optimize = b.option(std.builtin.OptimizeMode, "server-optimize", "Optimization mode for the native server") orelse if (optimize == .Debug) .ReleaseSafe else optimize;
    const native_ghostty = b.dependency("ghostty", .{
        .target = target,
        .optimize = server_optimize,
        .simd = false,
        .@"emit-lib-vt" = true,
        .@"vt-features" = "-all,+snapshot,+kitty-graphics",
    });
    const native_graphics = b.createModule(.{
        .root_source_file = b.path("../common/terminal/graphics/Adapter.zig"),
        .target = target,
        .optimize = server_optimize,
        .imports = &.{.{ .name = "ghostty-vt", .module = native_ghostty.module("ghostty-vt") }},
    });
    const native_graphics_checkpoint = b.createModule(.{
        .root_source_file = b.path("../common/terminal/graphics/Checkpoint.zig"),
        .target = target,
        .optimize = server_optimize,
        .imports = &.{.{ .name = "ghostty-vt", .module = native_ghostty.module("ghostty-vt") }},
    });
    const target_zstd = zstd_build.add(b, zstd_dep, target, server_optimize);
    const bcwebmux_core = b.addLibrary(.{
        .name = "bcwebmux_core",
        .linkage = .static,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/c_api.zig"),
            .target = target,
            .optimize = server_optimize,
            .pic = true,
            .imports = &.{
                .{ .name = "ghostty-vt", .module = native_ghostty.module("ghostty-vt") },
                .{ .name = "terminal-graphics", .module = native_graphics },
                .{ .name = "terminal-graphics-checkpoint", .module = native_graphics_checkpoint },
            },
        }),
    });
    bcwebmux_core.root_module.addIncludePath(b.path("include"));
    bcwebmux_core.root_module.addIncludePath(zstd_dep.path("lib"));
    bcwebmux_core.root_module.link_libc = true;
    bcwebmux_core.root_module.linkLibrary(target_zstd);
    const bcwebmux_worker = b.addExecutable(.{
        .name = "bcwebmux-worker",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/worker_main.zig"),
            .target = target,
            .optimize = server_optimize,
        }),
    });
    bcwebmux_worker.root_module.link_libc = true;
    bcwebmux_worker.root_module.linkSystemLibrary("util", .{});
    const wasm = b.addExecutable(.{
        .name = "terminal",
        .root_module = b.createModule(.{
            .root_source_file = b.path("../common/terminal/main.zig"),
            .target = wasm_target,
            .optimize = wasm_optimize,
            .imports = &.{.{
                .name = "ghostty-vt",
                .module = ghostty.module("ghostty-vt"),
            }},
        }),
    });
    wasm.root_module.addCSourceFile(.{
        .file = b.path("../common/terminal/font_engine.c"),
        .flags = &.{"-std=c23"},
    });
    wasm.root_module.addIncludePath(b.path("../common/terminal"));
    wasm.root_module.addIncludePath(kb.path(""));
    wasm.root_module.addIncludePath(stb.path(""));
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    wasm.export_memory = true;

    const terminal_wasm_install = b.addInstallFile(wasm.getEmittedBin(), "wgpu-terminal/terminal.wasm");
    const terminal_wasm_step = b.step("terminal-wasm", "Build the embeddable terminal WASM package asset");
    terminal_wasm_step.dependOn(&terminal_wasm_install.step);
    const web_assets = b.addWriteFiles();
    _ = web_assets.addCopyDirectory(b.path("web"), "", .{ .exclude_extensions = &.{".woff2"} });
    _ = web_assets.addCopyDirectory(b.path("../wgpuTerminal/src"), "wgpuTerminal/src", .{});
    _ = web_assets.addCopyDirectory(b.path("../wgpuTerminal/css"), "wgpuTerminal/css", .{});
    _ = web_assets.addCopyFile(b.path("../node_modules/fzstd/esm/index.mjs"), "fzstd.js");
    for (terminal_font_styles) |style| {
        const basename = b.fmt("JetBrainsMonoNerdFontMono-{s}", .{style});
        const font = jetbrains_mono_nerd_font.path(b.fmt("{s}.ttf", .{basename}));
        const font_install = b.addInstallFile(font, b.fmt("wgpu-terminal/fonts/{s}.ttf", .{basename}));
        terminal_wasm_step.dependOn(&font_install.step);
        _ = web_assets.addCopyFile(font, b.fmt("fonts/{s}.ttf", .{basename}));
    }
    const font_license_install = b.addInstallFile(b.path("web/fonts/OFL.txt"), "wgpu-terminal/fonts/OFL.txt");
    terminal_wasm_step.dependOn(&font_license_install.step);
    _ = web_assets.addCopyFile(
        b.path("../node_modules/@fontsource/noto-emoji/files/noto-emoji-emoji-400-normal.woff2"),
        "fonts/NotoEmoji-Regular.woff2",
    );
    _ = web_assets.addCopyFile(wasm.getEmittedBin(), "terminal.wasm");

    const go_frontend = go_build.add(b, target, server_optimize, web_assets.getDirectory(), bcwebmux_core, target_zstd);
    const tar = b.addSystemCommand(&.{
        "tar",
        "--format=ustar",
        "--sort=name",
        "--mtime=@0",
        "--owner=0",
        "--group=0",
        "--numeric-owner",
    });
    tar.setCwd(web_assets.getDirectory());
    tar.addArg("-cf");
    const tar_file = tar.addOutputFileArg("web-assets.tar");
    tar.addArg(".");

    const zstd_compressor = zstd_build.addCompressor(b, zstd_dep, .ReleaseFast);
    const zstd = b.addRunArtifact(zstd_compressor);
    const compressed_assets = zstd.addOutputFileArg("web-assets.tar.zst");
    zstd.addFileArg(tar_file);

    const server_embeds = b.addWriteFiles();
    _ = server_embeds.addCopyFile(compressed_assets, "web-assets.tar.zst");
    const assets_module = b.createModule(.{
        .root_source_file = server_embeds.add("assets.zig", "pub const data = @embedFile(\"web-assets.tar.zst\");\n"),
        .target = target,
        .optimize = server_optimize,
    });
    const server = b.addExecutable(.{
        .name = "bcwebmux-server",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/server.zig"),
            .target = target,
            .optimize = server_optimize,
            .imports = &.{ .{
                .name = "web_assets",
                .module = assets_module,
            }, .{
                .name = "ghostty-vt",
                .module = native_ghostty.module("ghostty-vt"),
            } },
        }),
    });
    server.root_module.addIncludePath(zstd_dep.path("lib"));
    server.root_module.link_libc = true;
    server.root_module.linkSystemLibrary("util", .{});
    server.root_module.linkLibrary(target_zstd);
    const go_install = b.addInstallBinFile(go_frontend.server, "bcwebmux-server");
    b.getInstallStep().dependOn(&go_install.step);
    b.installArtifact(bcwebmux_worker);
    const core_install = b.addInstallLibFile(bcwebmux_core.getEmittedBin(), "libbcwebmux_core.a");
    b.getInstallStep().dependOn(&core_install.step);
    const header_install = b.addInstallHeaderFile(b.path("include/bcwebmux.h"), "bcwebmux.h");
    b.getInstallStep().dependOn(&header_install.step);

    b.installDirectory(.{ .source_dir = web_assets.getDirectory(), .install_dir = .prefix, .install_subdir = "web" });

    const run_legacy = b.addRunArtifact(server);
    if (b.args) |args| run_legacy.addArgs(args);
    const legacy_build_step = b.step("legacy-build", "Build the legacy Zig server without running it");
    legacy_build_step.dependOn(&server.step);
    const legacy_step = b.step("legacy", "Build and run the legacy Zig PTY web server");
    legacy_step.dependOn(&run_legacy.step);

    const run_server = b.addSystemCommand(&.{b.getInstallPath(.bin, "bcwebmux-server")});
    run_server.step.dependOn(b.getInstallStep());
    if (b.args) |args| run_server.addArgs(args);
    const server_step = b.step("server", "Build and run the PTY web server");
    server_step.dependOn(&run_server.step);

    const native_tests = b.addTest(.{
        .filters = test_filters,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/tests.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{
                .{ .name = "ghostty-vt", .module = native_ghostty.module("ghostty-vt") },
                .{ .name = "terminal-graphics", .module = native_graphics },
                .{ .name = "terminal-graphics-checkpoint", .module = native_graphics_checkpoint },
            },
        }),
    });
    native_tests.root_module.link_libc = true;
    native_tests.root_module.addIncludePath(b.path("include"));
    native_tests.root_module.addIncludePath(zstd_dep.path("lib"));
    native_tests.root_module.linkLibrary(target_zstd);
    const run_native_tests = b.addRunArtifact(native_tests);
    const test_step = b.step("test", "Run Zig unit tests, or compile them for a cross target");
    if (runnable_target) {
        test_step.dependOn(&run_native_tests.step);
    } else {
        test_step.dependOn(&native_tests.step);
    }
}
