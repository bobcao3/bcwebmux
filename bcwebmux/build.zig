// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");
const go_build = @import("build/go.zig");
const zstd_build = @import("build/zstd.zig");

pub fn build(b: *std.Build) void {
    const target = b.standardTargetOptions(.{ .default_target = .{ .os_tag = .linux, .abi = .musl, .cpu_model = .baseline } });
    const runnable_target = target.result.cpu.arch == b.graph.host.result.cpu.arch and target.result.os.tag == b.graph.host.result.os.tag;
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
    const zstd_dep = b.dependency("zstd", .{});
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
    const target_zstd = zstd_build.add(b, zstd_dep, target, server_optimize);
    const bcwebmux_core = b.addLibrary(.{
        .name = "bcwebmux_core",
        .linkage = .static,
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/c_api.zig"),
            .target = target,
            .optimize = server_optimize,
            .pic = true,
            .imports = &.{.{
                .name = "ghostty-vt",
                .module = native_ghostty.module("ghostty-vt"),
            }},
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

    const host_ghostty = b.dependency("ghostty", .{
        .target = b.graph.host,
        .optimize = server_optimize,
        .simd = false,
        .@"emit-lib-vt" = true,
        .@"vt-features" = "-all,+snapshot",
    });
    const snapshot_fixture = b.addExecutable(.{
        .name = "snapshot-fixture",
        .root_module = b.createModule(.{
            .root_source_file = b.path("test/snapshot-fixture.zig"),
            .target = b.graph.host,
            .optimize = optimize,
            .imports = &.{.{
                .name = "ghostty-vt",
                .module = host_ghostty.module("ghostty-vt"),
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
    const render_frame_contract_cmd = b.addSystemCommand(&.{ "node", "test/render-frame-contract.mjs" });
    const renderer_integration_contract_cmd = b.addSystemCommand(&.{ "node", "test/renderer-integration-contract.mjs" });
    render_frame_contract_cmd.step.dependOn(&renderer_integration_contract_cmd.step);
    const frame_presenter_contract_cmd = b.addSystemCommand(&.{ "node", "test/frame-presenter-contract.mjs" });
    const canvas_text_contract_cmd = b.addSystemCommand(&.{ "node", "test/canvas-text-contract.mjs" });
    render_frame_contract_cmd.step.dependOn(&canvas_text_contract_cmd.step);
    const frame_scheduler_contract_cmd = b.addSystemCommand(&.{ "node", "test/frame-scheduler-contract.mjs" });
    render_frame_contract_cmd.step.dependOn(&frame_scheduler_contract_cmd.step);
    render_frame_contract_cmd.step.dependOn(&frame_presenter_contract_cmd.step);
    render_frame_contract_cmd.step.dependOn(&terminal_wasm_install.step);
    render_frame_contract_cmd.addArg(b.getInstallPath(.prefix, "wgpu-terminal/terminal.wasm"));
    const render_frame_contract_step = b.step("render-frame-test", "Check CPU frame and browser renderer ownership contracts");
    render_frame_contract_step.dependOn(&render_frame_contract_cmd.step);

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
        render_frame_contract_cmd.step.dependOn(&font_install.step);
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

    const network_relay_cmd = b.addSystemCommand(&.{ "node", "--test", "test/network-relay.test.mjs", "test/network-recovery.test.mjs" });
    const network_relay_step = b.step("network-relay-test", "Run network relay tests");
    network_relay_step.dependOn(&network_relay_cmd.step);

    const visual_compare_cmd = b.addSystemCommand(&.{ "node", "--test", "test/visual-compare.test.mjs" });
    const visual_cmd = b.addSystemCommand(&.{ "node", "test/visual-e2e.mjs" });
    visual_cmd.step.dependOn(b.getInstallStep());
    visual_cmd.step.dependOn(&visual_compare_cmd.step);
    visual_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    const visual_step = b.step("visual-test", "Run full-viewport desktop/mobile screenshot regressions on both GPU backends");
    visual_step.dependOn(&visual_cmd.step);
    const e2e_cmd = b.addSystemCommand(&.{ "node", "test/gpu-e2e.mjs" });
    e2e_cmd.step.dependOn(&visual_cmd.step);
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
    const go_https_integration_cmd = b.addSystemCommand(&.{ "node", "test/go-https-integration.mjs" });
    go_https_integration_cmd.step.dependOn(b.getInstallStep());
    go_https_integration_cmd.addArg(b.getInstallPath(.bin, "bcwebmux-server"));
    const server_test_step = b.step("server-test", "Run native server tests, or compile cross-target Go tests");
    const session_shell_integration_cmd = b.addSystemCommand(&.{ "node", "test/session-shell-integration.mjs" });
    session_shell_integration_cmd.step.dependOn(b.getInstallStep());
    session_shell_integration_cmd.addArg(b.getInstallPath(.bin, "bcwebmux-server"));
    if (runnable_target) {
        server_test_step.dependOn(&session_shell_integration_cmd.step);
        server_test_step.dependOn(&session_api_integration_cmd.step);
        server_test_step.dependOn(&session_ws_protocol_cmd.step);
        server_test_step.dependOn(&go_https_integration_cmd.step);
    }
    server_test_step.dependOn(go_frontend.test_step);
    const session_browser_resume_cmd = b.addSystemCommand(&.{ "node", "test/session-browser-resume.mjs" });
    session_browser_resume_cmd.step.dependOn(b.getInstallStep());
    session_browser_resume_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    const session_controller_contract_cmd = b.addSystemCommand(&.{ "node", "test/session-controller-contract.mjs" });
    session_controller_contract_cmd.step.dependOn(b.getInstallStep());
    session_controller_contract_cmd.step.dependOn(&session_browser_resume_cmd.step);
    const session_transport_contract_cmd = b.addSystemCommand(&.{ "node", "test/session-transport-contract.mjs" });
    session_transport_contract_cmd.step.dependOn(b.getInstallStep());
    session_transport_contract_cmd.addArg(b.getInstallPath(.prefix, "web"));
    const session_transport_step = b.step("session-transport-test", "Run deterministic fake-clock SessionTransport recovery contracts");
    session_transport_step.dependOn(&session_transport_contract_cmd.step);
    const session_checkpoint_contract_cmd = b.addSystemCommand(&.{ "node", "test/session-checkpoint-contract.mjs" });
    session_checkpoint_contract_cmd.step.dependOn(b.getInstallStep());
    session_checkpoint_contract_cmd.step.dependOn(&session_controller_contract_cmd.step);
    session_checkpoint_contract_cmd.step.dependOn(&session_transport_contract_cmd.step);
    session_checkpoint_contract_cmd.addArgs(&.{
        b.getInstallPath(.prefix, "web"),
    });
    session_checkpoint_contract_cmd.addArtifactArg(zstd_compressor);
    const wasm_font_contract_cmd = b.addSystemCommand(&.{ "node", "test/wasm-font-contract.mjs" });
    wasm_font_contract_cmd.step.dependOn(b.getInstallStep());
    wasm_font_contract_cmd.step.dependOn(&session_checkpoint_contract_cmd.step);
    const wasm_size_contract_cmd = b.addSystemCommand(&.{ "node", "test/wasm-size-contract.mjs" });
    wasm_size_contract_cmd.step.dependOn(b.getInstallStep());
    wasm_size_contract_cmd.step.dependOn(&wasm_font_contract_cmd.step);
    wasm_size_contract_cmd.addArgs(&.{
        b.getInstallPath(.prefix, "web/terminal.wasm"),
    });
    const wasm_logging_contract_cmd = b.addSystemCommand(&.{ "node", "test/wasm-logging-regression.mjs" });
    wasm_logging_contract_cmd.step.dependOn(b.getInstallStep());
    wasm_logging_contract_cmd.addArg(b.getInstallPath(.prefix, "web/terminal.wasm"));
    wasm_size_contract_cmd.step.dependOn(&wasm_logging_contract_cmd.step);
    const wasm_effects_contract_cmd = b.addSystemCommand(&.{ "node", "test/wasm-effects-contract.mjs" });
    wasm_effects_contract_cmd.step.dependOn(b.getInstallStep());
    wasm_effects_contract_cmd.addArg(b.getInstallPath(.prefix, "web/terminal.wasm"));
    wasm_size_contract_cmd.step.dependOn(&wasm_effects_contract_cmd.step);
    const session_ui_e2e_cmd = b.addSystemCommand(&.{ "timeout", "120s", "node", "test/session-ui-e2e.mjs" });
    session_ui_e2e_cmd.step.dependOn(b.getInstallStep());
    session_ui_e2e_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    e2e_cmd.step.dependOn(&mouse_selection_cmd.step);
    terminal_core_integration_cmd.step.dependOn(&e2e_webgl_cmd.step);
    const text_renderer_test_step = b.step("text-renderer-test", "Run text contracts, Unicode goldens and physical-GPU core/font lifecycle tests");
    text_renderer_test_step.dependOn(render_frame_contract_step);
    text_renderer_test_step.dependOn(&terminal_core_integration_dpr4_webgl_cmd.step);
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

    const native_tests = b.addTest(.{
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/tests.zig"),
            .target = target,
            .optimize = optimize,
            .imports = &.{.{
                .name = "ghostty-vt",
                .module = native_ghostty.module("ghostty-vt"),
            }},
        }),
    });
    native_tests.root_module.link_libc = true;
    native_tests.root_module.addIncludePath(b.path("include"));
    native_tests.root_module.addIncludePath(zstd_dep.path("lib"));
    native_tests.root_module.linkLibrary(target_zstd);
    const run_native_tests = b.addRunArtifact(native_tests);
    const unit_test_step = b.step("unit-test", "Run Zig unit tests, or compile them for a cross target");
    if (runnable_target) {
        unit_test_step.dependOn(&run_native_tests.step);
    } else {
        unit_test_step.dependOn(&native_tests.step);
    }
    const protocol_contract_cmd = b.addSystemCommand(&.{ "node", "test/protocol-contract.mjs" });
    const glyph_cache_layout_cmd = b.addSystemCommand(&.{ "node", "test/glyph-cache-layout.mjs" });
    const utf_probe_cmd = b.addSystemCommand(&.{ "node", "test/utf-probe.mjs" });
    utf_probe_cmd.step.dependOn(b.getInstallStep());
    utf_probe_cmd.addArg(b.getInstallPath(.prefix, "web"));
    const test_step = b.step("test", "Run unit and browser end-to-end tests");
    test_step.dependOn(unit_test_step);
    test_step.dependOn(render_frame_contract_step);
    test_step.dependOn(&network_relay_cmd.step);
    test_step.dependOn(&protocol_contract_cmd.step);
    test_step.dependOn(&glyph_cache_layout_cmd.step);
    test_step.dependOn(&utf_probe_cmd.step);
    test_step.dependOn(&e2e_cmd.step);
    test_step.dependOn(&terminal_core_integration_cmd.step);
    test_step.dependOn(&terminal_core_integration_dpr4_webgl_cmd.step);
    test_step.dependOn(&session_browser_resume_cmd.step);
    test_step.dependOn(&session_controller_contract_cmd.step);
    test_step.dependOn(&session_checkpoint_contract_cmd.step);
    test_step.dependOn(&wasm_font_contract_cmd.step);
    test_step.dependOn(&wasm_size_contract_cmd.step);
    test_step.dependOn(&session_ui_e2e_cmd.step);
    test_step.dependOn(server_test_step);
}
