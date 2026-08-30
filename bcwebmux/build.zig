// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{});
    const optimize = b.standardOptimizeOption(.{});
    const wasm_optimize = b.option(std.builtin.OptimizeMode, "wasm-optimize", "Optimization mode for WebAssembly") orelse .ReleaseSmall;

    var wasm_query = std.Target.Query{
        .cpu_arch = .wasm32,
        .os_tag = .freestanding,
    };
    wasm_query.cpu_features_add.addFeature(@intFromEnum(std.Target.wasm.Feature.simd128));
    const wasm_target = b.resolveTargetQuery(wasm_query);
    const kb = b.dependency("kb", .{ .target = wasm_target, .optimize = wasm_optimize });
    const stb = b.dependency("stb", .{ .target = wasm_target, .optimize = wasm_optimize });
    const jetbrains_mono_nerd_font = b.dependency("jetbrains_mono_nerd_font", .{});
    const terminal_font_styles = [_][]const u8{ "Regular", "Bold", "Italic", "BoldItalic" };
    const ghostty = b.dependency("ghostty", .{
        .target = wasm_target,
        .optimize = wasm_optimize,
        .simd = false,
        .@"emit-lib-vt" = true,
        .@"vt-features" = "-all,+render-state,+input-encode,+selection,+snapshot",
    });
    // The headless server is latency-sensitive; Debug Ghostty makes output-heavy apps unusably slow.
    const server_optimize = b.option(std.builtin.OptimizeMode, "server-optimize", "Optimization mode for the native server") orelse if (optimize == .Debug) .ReleaseSafe else optimize;
    const native_ghostty = b.dependency("ghostty", .{
        .target = target,
        .optimize = server_optimize,
        .simd = false,
        .@"emit-lib-vt" = true,
        .@"vt-features" = "-all,+snapshot",
    });
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

    const snapshot_fixture = b.addExecutable(.{
        .name = "snapshot-fixture",
        .root_module = b.createModule(.{
            .root_source_file = b.path("test/snapshot-fixture.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{
                .name = "ghostty-vt",
                .module = native_ghostty.module("ghostty-vt"),
            }},
        }),
    });
    const snapshot_fixture_csi_run = b.addRunArtifact(snapshot_fixture);
    const snapshot_csi_file = snapshot_fixture_csi_run.addOutputFileArg("terminal-core-csi.snapshot");
    snapshot_fixture_csi_run.addArg("csi");
    const snapshot_fixture_utf8_run = b.addRunArtifact(snapshot_fixture);
    const snapshot_utf8_file = snapshot_fixture_utf8_run.addOutputFileArg("terminal-core-utf8.snapshot");
    snapshot_fixture_utf8_run.addArg("utf8");

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

    const terminal_core_test_assets = b.addWriteFiles();
    _ = terminal_core_test_assets.addCopyDirectory(web_assets.getDirectory(), "", .{});
    _ = terminal_core_test_assets.addCopyDirectory(b.path("test/terminal-core"), "terminal-core", .{});
    _ = terminal_core_test_assets.addCopyFile(snapshot_csi_file, "terminal-core/fixtures/terminal-core-csi.snapshot");
    _ = terminal_core_test_assets.addCopyFile(snapshot_utf8_file, "terminal-core/fixtures/terminal-core-utf8.snapshot");

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

    const zstd = b.addSystemCommand(&.{ "zstd", "-q", "-19", "-f", "--no-progress", "-o" });
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
    server.root_module.link_libc = true;
    server.root_module.linkSystemLibrary("util", .{});
    server.root_module.linkSystemLibrary("zstd", .{});
    b.installArtifact(server);

    b.installDirectory(.{ .source_dir = web_assets.getDirectory(), .install_dir = .prefix, .install_subdir = "web" });

    const run_server = b.addRunArtifact(server);
    run_server.step.dependOn(b.getInstallStep());
    run_server.addArgs(&.{ "--web-root", b.getInstallPath(.prefix, "web") });
    if (b.args) |args| run_server.addArgs(args);
    const server_step = b.step("server", "Build and run the PTY web server");
    server_step.dependOn(&run_server.step);

    const e2e_cmd = b.addSystemCommand(&.{ "node", "test/gpu-e2e.mjs" });
    e2e_cmd.step.dependOn(b.getInstallStep());
    e2e_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    const e2e_webgl_cmd = b.addSystemCommand(&.{ "node", "test/gpu-e2e.mjs" });
    e2e_webgl_cmd.step.dependOn(b.getInstallStep());
    e2e_webgl_cmd.step.dependOn(&e2e_cmd.step);
    e2e_webgl_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    e2e_webgl_cmd.setEnvironmentVariable("RENDER_BACKEND", "webgl2");
    const mouse_selection_cmd = b.addSystemCommand(&.{
        "node",
        "test/mouse-selection-e2e.mjs",
    });
    mouse_selection_cmd.step.dependOn(b.getInstallStep());
    mouse_selection_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    const terminal_core_integration_cmd = b.addSystemCommand(&.{ "node", "test/terminal-core-integration.mjs" });
    terminal_core_integration_cmd.step.dependOn(b.getInstallStep());
    terminal_core_integration_cmd.addArg(b.getInstallPath(.bin, "bcwebmux-server"));
    terminal_core_integration_cmd.addDirectoryArg(terminal_core_test_assets.getDirectory());
    const terminal_core_integration_dpr4_webgpu_cmd = b.addSystemCommand(&.{ "node", "test/terminal-core-integration.mjs" });
    terminal_core_integration_dpr4_webgpu_cmd.step.dependOn(b.getInstallStep());
    terminal_core_integration_dpr4_webgpu_cmd.step.dependOn(&terminal_core_integration_cmd.step);
    terminal_core_integration_dpr4_webgpu_cmd.addArg(b.getInstallPath(.bin, "bcwebmux-server"));
    terminal_core_integration_dpr4_webgpu_cmd.addDirectoryArg(terminal_core_test_assets.getDirectory());
    terminal_core_integration_dpr4_webgpu_cmd.setEnvironmentVariable("DEVICE_SCALE_FACTOR", "4");
    terminal_core_integration_dpr4_webgpu_cmd.setEnvironmentVariable("RENDER_BACKEND", "webgpu");
    const terminal_core_integration_dpr4_webgl_cmd = b.addSystemCommand(&.{ "node", "test/terminal-core-integration.mjs" });
    terminal_core_integration_dpr4_webgl_cmd.step.dependOn(b.getInstallStep());
    terminal_core_integration_dpr4_webgl_cmd.step.dependOn(&terminal_core_integration_dpr4_webgpu_cmd.step);
    terminal_core_integration_dpr4_webgl_cmd.addArg(b.getInstallPath(.bin, "bcwebmux-server"));
    terminal_core_integration_dpr4_webgl_cmd.addDirectoryArg(terminal_core_test_assets.getDirectory());
    terminal_core_integration_dpr4_webgl_cmd.setEnvironmentVariable("DEVICE_SCALE_FACTOR", "4");
    terminal_core_integration_dpr4_webgl_cmd.setEnvironmentVariable("RENDER_BACKEND", "webgl2");
    const session_api_integration_cmd = b.addSystemCommand(&.{ "node", "test/session-api-integration.mjs" });
    session_api_integration_cmd.step.dependOn(b.getInstallStep());
    session_api_integration_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
    });
    const session_ws_protocol_cmd = b.addSystemCommand(&.{ "node", "test/session-ws-protocol.mjs" });
    session_ws_protocol_cmd.step.dependOn(b.getInstallStep());
    session_ws_protocol_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
    });
    const session_browser_resume_cmd = b.addSystemCommand(&.{ "node", "test/session-browser-resume.mjs" });
    session_browser_resume_cmd.step.dependOn(b.getInstallStep());
    session_browser_resume_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    const session_controller_contract_cmd = b.addSystemCommand(&.{ "node", "test/session-controller-contract.mjs" });
    session_controller_contract_cmd.step.dependOn(b.getInstallStep());
    session_controller_contract_cmd.step.dependOn(&session_browser_resume_cmd.step);
    const session_checkpoint_contract_cmd = b.addSystemCommand(&.{ "node", "test/session-checkpoint-contract.mjs" });
    session_checkpoint_contract_cmd.step.dependOn(b.getInstallStep());
    session_checkpoint_contract_cmd.step.dependOn(&session_controller_contract_cmd.step);
    session_checkpoint_contract_cmd.addArgs(&.{
        b.getInstallPath(.prefix, "web"),
    });
    const wasm_font_contract_cmd = b.addSystemCommand(&.{ "node", "test/wasm-font-contract.mjs" });
    wasm_font_contract_cmd.step.dependOn(b.getInstallStep());
    wasm_font_contract_cmd.step.dependOn(&session_checkpoint_contract_cmd.step);
    const wasm_size_contract_cmd = b.addSystemCommand(&.{ "node", "test/wasm-size-contract.mjs" });
    wasm_size_contract_cmd.step.dependOn(b.getInstallStep());
    wasm_size_contract_cmd.step.dependOn(&wasm_font_contract_cmd.step);
    wasm_size_contract_cmd.addArgs(&.{
        b.getInstallPath(.prefix, "web/terminal.wasm"),
    });
    const session_ui_e2e_cmd = b.addSystemCommand(&.{ "timeout", "120s", "node", "test/session-ui-e2e.mjs" });
    session_ui_e2e_cmd.step.dependOn(b.getInstallStep());
    session_ui_e2e_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    e2e_cmd.step.dependOn(&mouse_selection_cmd.step);
    terminal_core_integration_cmd.step.dependOn(&e2e_webgl_cmd.step);
    session_browser_resume_cmd.step.dependOn(&e2e_cmd.step);
    session_browser_resume_cmd.step.dependOn(&terminal_core_integration_cmd.step);
    session_ui_e2e_cmd.step.dependOn(&wasm_size_contract_cmd.step);
    const e2e_step = b.step("e2e", "Run the physical-GPU browser-to-PTY end-to-end test");
    e2e_step.dependOn(&e2e_cmd.step);
    e2e_step.dependOn(&e2e_webgl_cmd.step);
    e2e_step.dependOn(&terminal_core_integration_cmd.step);
    e2e_step.dependOn(&terminal_core_integration_dpr4_webgl_cmd.step);
    e2e_step.dependOn(&session_browser_resume_cmd.step);
    e2e_step.dependOn(&session_controller_contract_cmd.step);
    e2e_step.dependOn(&session_checkpoint_contract_cmd.step);
    e2e_step.dependOn(&wasm_font_contract_cmd.step);
    e2e_step.dependOn(&wasm_size_contract_cmd.step);
    e2e_step.dependOn(&session_ui_e2e_cmd.step);

    const protocol_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/protocol.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_protocol_tests = b.addRunArtifact(protocol_tests);
    const vfs_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/vfs.zig"),
            .target = target,
            .optimize = optimize,
        }),
    });
    const run_vfs_tests = b.addRunArtifact(vfs_tests);
    const session_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/Session.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{
                .name = "ghostty-vt",
                .module = native_ghostty.module("ghostty-vt"),
            }},
        }),
    });
    const run_session_tests = b.addRunArtifact(session_tests);
    const session_registry_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/SessionRegistry.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{
                .name = "ghostty-vt",
                .module = native_ghostty.module("ghostty-vt"),
            }},
        }),
    });
    const run_session_registry_tests = b.addRunArtifact(session_registry_tests);
    const protocol_contract_cmd = b.addSystemCommand(&.{ "node", "test/protocol-contract.mjs" });
    const glyph_cache_layout_cmd = b.addSystemCommand(&.{ "node", "test/glyph-cache-layout.mjs" });
    const utf_probe_cmd = b.addSystemCommand(&.{ "node", "test/utf-probe.mjs" });
    utf_probe_cmd.step.dependOn(b.getInstallStep());
    const test_step = b.step("test", "Run unit and browser end-to-end tests");
    test_step.dependOn(&run_protocol_tests.step);
    test_step.dependOn(&run_vfs_tests.step);
    test_step.dependOn(&run_session_tests.step);
    test_step.dependOn(&run_session_registry_tests.step);
    test_step.dependOn(&protocol_contract_cmd.step);
    test_step.dependOn(&glyph_cache_layout_cmd.step);
    test_step.dependOn(&utf_probe_cmd.step);
    test_step.dependOn(&e2e_cmd.step);
    test_step.dependOn(&terminal_core_integration_cmd.step);
    test_step.dependOn(&terminal_core_integration_dpr4_webgl_cmd.step);
    test_step.dependOn(&session_api_integration_cmd.step);
    test_step.dependOn(&session_ws_protocol_cmd.step);
    test_step.dependOn(&session_browser_resume_cmd.step);
    test_step.dependOn(&session_controller_contract_cmd.step);
    test_step.dependOn(&session_checkpoint_contract_cmd.step);
    test_step.dependOn(&wasm_font_contract_cmd.step);
    test_step.dependOn(&wasm_size_contract_cmd.step);
    test_step.dependOn(&session_ui_e2e_cmd.step);
}
