// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const Translator = @import("translate_c").Translator;
const go_build = @import("build/go.zig");
const webp_build = @import("build/webp.zig");
const zstd_build = @import("build/zstd.zig");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{ .default_target = .{ .os_tag = .linux, .abi = .musl, .cpu_model = .baseline } });
    const runnable_target = target.result.cpu.arch == b.graph.host.result.cpu.arch and target.result.os.tag == b.graph.host.result.os.tag;
    const optimize = b.standardOptimizeOption(.{});
    const test_filters = b.option([][]const u8, "test-filter", "Filter Zig tests") orelse &[0][]const u8{};
    const wasm_optimize = b.option(std.lang.Optimize, "wasm-optimize", "Optimization mode for WebAssembly") orelse .small;

    var wasm_query = std.Target.Query{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    };
    wasm_query.cpu_features_add.addFeature(@backingInt(std.Target.wasm.Feature.simd128));
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
    const server_optimize = b.option(std.lang.Optimize, "server-optimize", "Optimization mode for the native server") orelse if (optimize == .debug) .safe else optimize;
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
    const target_zstd = zstd_build.add(b, zstd_dep, target, server_optimize);
    // Image encoding is the server's hot path; a size-optimized libwebp encodes
    // markedly slower for a few hundred kilobytes saved.
    const webp_optimize: std.lang.Optimize = if (server_optimize == .small) .fast else server_optimize;
    const libwebp = b.dependency("libwebp", .{});
    const target_webp = webp_build.add(b, libwebp, target, webp_optimize);
    // Ghostty already compiles Wuffs for Kitty graphics; the transcoder decodes
    // PNG with that same memory-safe instance.
    const wuffs_dep = native_ghostty.builder.lazyDependency("wuffs", .{ .target = target, .optimize = server_optimize }) orelse return;
    const wuffs = wuffs_dep.module("wuffs");
    // C declarations for the native server, worker and tests.
    const posix_c = translateC(b, "posix-c",
        \\#define _XOPEN_SOURCE 600
        \\#define _FORTIFY_SOURCE 0
        \\#include <fcntl.h>
        \\#include <poll.h>
        \\#include <pty.h>
        \\#include <pwd.h>
        \\#include <signal.h>
        \\#include <stdlib.h>
        \\#include <sys/ioctl.h>
        \\#include <sys/socket.h>
        \\#include <sys/stat.h>
        \\#include <sys/file.h>
        \\#include <sys/wait.h>
        \\#include <unistd.h>
        \\
    , target, server_optimize, &.{});
    const zstd_c = translateC(b, "zstd-c", "#include <zstd.h>\n", target, server_optimize, &.{zstd_dep.path("lib")});
    const webp_c = translateC(b, "webp-c",
        \\#include <webp/encode.h>
        \\#include <webp/decode.h>
        \\
    , target, server_optimize, &.{libwebp.path("src")});
    const bcwebmux_c = translateC(b, "bcwebmux-c", "#include <bcwebmux.h>\n", target, server_optimize, &.{b.path("include")});
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
                .{ .name = "wuffs", .module = wuffs },
                .{ .name = "posix-c", .module = posix_c },
                .{ .name = "zstd-c", .module = zstd_c },
                .{ .name = "webp-c", .module = webp_c },
                .{ .name = "bcwebmux-c", .module = bcwebmux_c },
            },
        }),
    });
    bcwebmux_core.root_module.link_libc = true;
    bcwebmux_core.root_module.linkLibrary(target_zstd);
    bcwebmux_core.root_module.linkLibrary(target_webp);
    const bcwebmux_worker = b.addExecutable(.{
        .name = "bcwebmux-worker",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/worker_main.zig"),
            .target = target,
            .optimize = server_optimize,
            .imports = &.{
                .{ .name = "ghostty-vt", .module = native_ghostty.module("ghostty-vt") },
                .{ .name = "terminal-graphics", .module = native_graphics },
                .{ .name = "wuffs", .module = wuffs },
                .{ .name = "posix-c", .module = posix_c },
                .{ .name = "webp-c", .module = webp_c },
            },
        }),
    });
    bcwebmux_worker.root_module.link_libc = true;
    bcwebmux_worker.root_module.linkLibrary(target_webp);
    bcwebmux_worker.root_module.linkSystemLibrary("util", .{});
    const sessiond = b.addExecutable(.{
        .name = "bcwebmux-sessiond",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/session_daemon.zig"),
            .target = target,
            .optimize = server_optimize,
            .imports = &.{
                .{ .name = "ghostty-vt", .module = native_ghostty.module("ghostty-vt") },
                .{ .name = "terminal-graphics", .module = native_graphics },
                .{ .name = "wuffs", .module = wuffs },
                .{ .name = "posix-c", .module = posix_c },
                .{ .name = "zstd-c", .module = zstd_c },
                .{ .name = "webp-c", .module = webp_c },
                .{ .name = "bcwebmux-c", .module = bcwebmux_c },
            },
        }),
    });
    sessiond.root_module.link_libc = true;
    sessiond.root_module.linkLibrary(target_zstd);
    sessiond.root_module.linkLibrary(target_webp);
    b.installArtifact(sessiond);
    const sessiond_step = b.step("sessiond", "Build the session daemon and worker");
    sessiond_step.dependOn(&b.addInstallArtifact(sessiond, .{}).step);
    sessiond_step.dependOn(&b.addInstallArtifact(bcwebmux_worker, .{}).step);
    const wasm = b.addExecutable(.{
        .name = "terminal",
        .root_module = b.createModule(.{
            .root_source_file = b.path("../common/terminal/main.zig"),
            .target = wasm_target,
            .optimize = wasm_optimize,
            .imports = &.{
                .{ .name = "ghostty-vt", .module = ghostty.module("ghostty-vt") },
                .{ .name = "font-engine-c", .module = translateC(b, "font-engine-c",
                    \\#include <kb_text_shape.h>
                    \\#include <stb_truetype.h>
                    \\
                , wasm_target, wasm_optimize, &.{ kb.path(""), stb.path("") }) },
                .{ .name = "zstd-c", .module = translateC(b, "zstd-c",
                    \\#define ZSTD_STATIC_LINKING_ONLY 1
                    \\#include <zstd.h>
                    \\
                , wasm_target, wasm_optimize, &.{zstd_dep.path("lib")}) },
            },
        }),
    });
    wasm.root_module.addCSourceFile(.{
        .file = b.path("../common/terminal/font_engine.c"),
        .flags = &.{"-std=c23"},
    });
    wasm.root_module.addIncludePath(b.path("../common/terminal"));
    wasm.root_module.addIncludePath(kb.path(""));
    wasm.root_module.addIncludePath(stb.path(""));
    wasm.root_module.addIncludePath(zstd_dep.path("lib"));
    wasm.root_module.linkLibrary(zstd_build.addWasmDecoder(b, zstd_dep, wasm_target, wasm_optimize, b.path("../common/terminal/zstd_libc")));
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
    for (terminal_font_styles) |style| {
        const basename = b.fmt("JetBrainsMonoNerdFontMono-{s}", .{style});
        const font = jetbrains_mono_nerd_font.path(b.fmt("{s}.ttf", .{basename}));
        const font_install = b.addInstallFile(font, b.fmt("wgpu-terminal/fonts/{s}.ttf", .{basename}));
        terminal_wasm_step.dependOn(&font_install.step);
        _ = web_assets.addCopyFile(font, b.fmt("fonts/{s}.ttf", .{basename}));
    }
    const font_license_install = b.addInstallFile(b.path("web/fonts/OFL.txt"), "wgpu-terminal/fonts/OFL.txt");
    terminal_wasm_step.dependOn(&font_license_install.step);
    // The WASM terminal embeds Ghostty, so its notices must travel with the package.
    const notices_install = b.addInstallFile(b.path("../THIRD_PARTY_NOTICES.md"), "wgpu-terminal/THIRD_PARTY_NOTICES.md");
    terminal_wasm_step.dependOn(&notices_install.step);
    const terminal_licenses = b.addWriteFiles();
    _ = terminal_licenses.addCopyFile(b.path("../LICENSE"), "LICENSE");
    _ = terminal_licenses.addCopyFile(ghostty.path("LICENSE"), "Ghostty.txt");
    _ = terminal_licenses.addCopyFile(ghostty.builder.dependency("uucode", .{}).path("LICENSE.md"), "uucode.txt");
    _ = terminal_licenses.addCopyFile(kb.path("LICENSE"), "kb.txt");
    _ = terminal_licenses.addCopyFile(stb.path("LICENSE"), "stb.txt");
    _ = terminal_licenses.addCopyFile(zstd_dep.path("LICENSE"), "zstd.txt");
    const terminal_licenses_install = b.addInstallDirectory(.{
        .source_dir = terminal_licenses.getDirectory(),
        .install_dir = .prefix,
        .install_subdir = "wgpu-terminal/licenses",
    });
    terminal_wasm_step.dependOn(&terminal_licenses_install.step);
    _ = web_assets.addCopyFile(b.path("../THIRD_PARTY_NOTICES.md"), "THIRD_PARTY_NOTICES.md");
    _ = web_assets.addCopyFile(
        b.path("../node_modules/@fontsource/noto-color-emoji/files/noto-color-emoji-emoji-400-normal.woff2"),
        "fonts/NotoColorEmoji-Regular.woff2",
    );
    _ = web_assets.addCopyFile(
        b.path("../node_modules/@fontsource/noto-color-emoji/LICENSE"),
        "fonts/NotoColorEmoji-OFL.txt",
    );
    _ = web_assets.addCopyFile(wasm.getEmittedBin(), "terminal.wasm");

    const go_frontend = go_build.add(b, target, server_optimize, web_assets.getDirectory(), bcwebmux_core, target_zstd, target_webp);
    const go_install = b.addInstallBinFile(go_frontend.server, "bcwebmux-server");
    b.getInstallStep().dependOn(&go_install.step);
    b.installArtifact(bcwebmux_worker);
    const core_install = b.addInstallLibFile(bcwebmux_core.getEmittedBin(), "libbcwebmux_core.a");
    b.getInstallStep().dependOn(&core_install.step);
    const header_install = b.addInstallHeaderFile(b.path("include/bcwebmux.h"), "bcwebmux.h");
    b.getInstallStep().dependOn(&header_install.step);

    b.installDirectory(.{ .source_dir = web_assets.getDirectory(), .install_dir = .prefix, .install_subdir = "web" });

    const run_server = std.Build.Step.Run.create(b, "run bcwebmux-server");
    run_server.addFileArg(b.graph.path(.install_bin, "bcwebmux-server"));
    run_server.step.dependOn(b.getInstallStep());
    run_server.addPassthruArgs();
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
                .{ .name = "wuffs", .module = wuffs },
                .{ .name = "posix-c", .module = posix_c },
                .{ .name = "zstd-c", .module = zstd_c },
                .{ .name = "webp-c", .module = webp_c },
                .{ .name = "bcwebmux-c", .module = bcwebmux_c },
            },
        }),
    });
    native_tests.root_module.link_libc = true;
    native_tests.root_module.linkLibrary(target_zstd);
    native_tests.root_module.linkLibrary(target_webp);
    const run_native_tests = b.addRunArtifact(native_tests);
    const test_step = b.step("test", "Run Zig unit tests, or compile them for a cross target");
    if (runnable_target) {
        test_step.dependOn(&run_native_tests.step);
    } else {
        test_step.dependOn(&native_tests.step);
    }
}

/// Translates the C declarations `header` includes into an importable module.
fn translateC(
    b: *std.Build,
    name: []const u8,
    header: []const u8,
    target: std.Build.ResolvedTarget,
    optimize: std.lang.Optimize,
    include_paths: []const std.Build.LazyPath,
) *std.Build.Module {
    const translator: Translator = .init(b.dependency("translate_c", .{}), .{
        .name = name,
        .c_source_file = b.addWriteFiles().add(b.fmt("{s}.h", .{name}), header),
        .target = target,
        .optimize = optimize,
        // The freestanding terminal WASM has no libc.
        .link_libc = target.result.os.tag != .freestanding,
    });
    for (include_paths) |path| translator.addIncludePath(path);
    return translator.mod;
}
