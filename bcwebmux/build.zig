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
    const ghostty = b.dependency("ghostty", .{
        .target = wasm_target,
        .optimize = wasm_optimize,
        .simd = false,
        .@"emit-lib-vt" = true,
        .@"vt-features" = "-all,+render-state,+input-encode,+selection,+snapshot",
    });
    const native_ghostty = b.dependency("ghostty", .{
        .target = target,
        .optimize = optimize,
        .simd = false,
        .@"emit-lib-vt" = true,
        .@"vt-features" = "-all,+snapshot",
    });
    const terminal_fonts = b.addWriteFiles();
    _ = terminal_fonts.addCopyFile(
        jetbrains_mono_nerd_font.path("JetBrainsMonoNerdFontMono-Regular.ttf"),
        "regular.ttf",
    );
    _ = terminal_fonts.addCopyFile(
        jetbrains_mono_nerd_font.path("JetBrainsMonoNerdFontMono-Bold.ttf"),
        "bold.ttf",
    );
    _ = terminal_fonts.addCopyFile(
        jetbrains_mono_nerd_font.path("JetBrainsMonoNerdFontMono-Italic.ttf"),
        "italic.ttf",
    );
    _ = terminal_fonts.addCopyFile(
        jetbrains_mono_nerd_font.path("JetBrainsMonoNerdFontMono-BoldItalic.ttf"),
        "bold_italic.ttf",
    );
    const fonts_module = b.createModule(.{
        .root_source_file = terminal_fonts.add("fonts.zig",
            \\pub const regular = @embedFile("regular.ttf");
            \\pub const bold = @embedFile("bold.ttf");
            \\pub const italic = @embedFile("italic.ttf");
            \\pub const bold_italic = @embedFile("bold_italic.ttf");
            \\
        ),
        .target = wasm_target,
        .optimize = wasm_optimize,
    });
    const wasm = b.addExecutable(.{
        .name = "terminal",
        .root_module = b.createModule(.{
            .root_source_file = b.path("../common/terminal/main.zig"),
            .target = wasm_target,
            .optimize = wasm_optimize,
            .imports = &.{ .{
                .name = "ghostty-vt",
                .module = ghostty.module("ghostty-vt"),
            }, .{
                .name = "fonts",
                .module = fonts_module,
            } },
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
    for ([_][]const u8{ "Regular", "Bold", "Italic", "BoldItalic" }) |style| {
        const basename = b.fmt("JetBrainsMonoNerdFontMono-{s}", .{style});
        _ = web_assets.addCopyFile(
            compressWoff2(
                b,
                jetbrains_mono_nerd_font.path(b.fmt("{s}.ttf", .{basename})),
                basename,
            ),
            b.fmt("fonts/{s}.woff2", .{basename}),
        );
    }
    _ = web_assets.addCopyFile(
        b.path("../node_modules/@fontsource/noto-emoji/files/noto-emoji-emoji-400-normal.woff2"),
        "fonts/NotoEmoji-Regular.woff2",
    );
    _ = web_assets.addCopyFile(wasm.getEmittedBin(), "terminal.wasm");
    _ = web_assets.addCopyFile(snapshot_csi_file, "test/terminal-core-csi.snapshot");
    _ = web_assets.addCopyFile(snapshot_utf8_file, "test/terminal-core-utf8.snapshot");

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
        .optimize = optimize,
    });
    const server = b.addExecutable(.{
        .name = "bcwebmux-server",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/server.zig"),
            .target = target,
            .optimize = optimize,
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
    const mouse_selection_cmd = b.addSystemCommand(&.{
        "node",
        "test/mouse-selection-e2e.mjs",
    });
    mouse_selection_cmd.step.dependOn(b.getInstallStep());
    mouse_selection_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    const terminal_core_smoke_cmd = b.addSystemCommand(&.{ "node", "test/terminal-core-smoke.mjs" });
    terminal_core_smoke_cmd.step.dependOn(b.getInstallStep());
    terminal_core_smoke_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    const session_api_smoke_cmd = b.addSystemCommand(&.{ "node", "test/session-api-smoke.mjs" });
    session_api_smoke_cmd.step.dependOn(b.getInstallStep());
    session_api_smoke_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
    });
    const session_ws_smoke_cmd = b.addSystemCommand(&.{ "node", "test/session-ws-smoke.mjs" });
    session_ws_smoke_cmd.step.dependOn(b.getInstallStep());
    session_ws_smoke_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
    });
    const session_browser_smoke_cmd = b.addSystemCommand(&.{ "node", "test/session-browser-smoke.mjs" });
    session_browser_smoke_cmd.step.dependOn(b.getInstallStep());
    session_browser_smoke_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    const session_controller_contract_cmd = b.addSystemCommand(&.{ "node", "test/session-controller-contract.mjs" });
    session_controller_contract_cmd.step.dependOn(b.getInstallStep());
    session_controller_contract_cmd.step.dependOn(&session_browser_smoke_cmd.step);
    const session_ui_e2e_cmd = b.addSystemCommand(&.{ "timeout", "120s", "node", "test/session-ui-e2e.mjs" });
    session_ui_e2e_cmd.step.dependOn(b.getInstallStep());
    session_ui_e2e_cmd.addArgs(&.{
        b.getInstallPath(.bin, "bcwebmux-server"),
        b.getInstallPath(.prefix, "web"),
    });
    e2e_cmd.step.dependOn(&mouse_selection_cmd.step);
    terminal_core_smoke_cmd.step.dependOn(&e2e_cmd.step);
    session_browser_smoke_cmd.step.dependOn(&e2e_cmd.step);
    session_browser_smoke_cmd.step.dependOn(&terminal_core_smoke_cmd.step);
    session_ui_e2e_cmd.step.dependOn(&session_controller_contract_cmd.step);
    const e2e_step = b.step("e2e", "Run the physical-GPU browser-to-PTY end-to-end test");
    e2e_step.dependOn(&e2e_cmd.step);
    e2e_step.dependOn(&terminal_core_smoke_cmd.step);
    e2e_step.dependOn(&session_browser_smoke_cmd.step);
    e2e_step.dependOn(&session_controller_contract_cmd.step);
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
    const test_step = b.step("test", "Run unit and browser end-to-end tests");
    test_step.dependOn(&run_protocol_tests.step);
    test_step.dependOn(&run_vfs_tests.step);
    test_step.dependOn(&run_session_tests.step);
    test_step.dependOn(&run_session_registry_tests.step);
    test_step.dependOn(&protocol_contract_cmd.step);
    test_step.dependOn(&e2e_cmd.step);
    test_step.dependOn(&terminal_core_smoke_cmd.step);
    test_step.dependOn(&session_api_smoke_cmd.step);
    test_step.dependOn(&session_ws_smoke_cmd.step);
    test_step.dependOn(&session_browser_smoke_cmd.step);
    test_step.dependOn(&session_controller_contract_cmd.step);
    test_step.dependOn(&session_ui_e2e_cmd.step);
}

fn compressWoff2(b: *std.Build, input: std.Build.LazyPath, basename: []const u8) std.Build.LazyPath {
    const command = b.addSystemCommand(&.{
        "sh",
        "-c",
        \\set -eu
        \\if ! command -v woff2_compress >/dev/null 2>&1; then
        \\    echo "error: woff2_compress was not found in PATH" >&2
        \\    exit 1
        \\fi
        \\input="$1"
        \\output="$2"
        \\temporary="${output%.woff2}.ttf"
        \\trap 'rm -f -- "$temporary"' EXIT
        \\cp -- "$input" "$temporary"
        \\if diagnostics="$(woff2_compress "$temporary" 2>&1)"; then
        \\    :
        \\else
        \\    printf '%s\n' "$diagnostics" >&2
        \\    exit 1
        \\fi
        ,
        "compressWoff2",
    });
    command.addFileArg(input);
    const output = command.addOutputFileArg(b.fmt("{s}.woff2", .{basename}));
    return output;
}
