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
    const ghostty = b.dependency("ghostty", .{
        .target = wasm_target,
        .optimize = wasm_optimize,
        .simd = false,
        .@"emit-lib-vt" = true,
        .@"vt-features" = "-all,+render-state,+input-encode,+selection",
    });
    const wasm = b.addExecutable(.{
        .name = "terminal",
        .root_module = b.createModule(.{
            .root_source_file = b.path("src/wasm.zig"),
            .target = wasm_target,
            .optimize = wasm_optimize,
            .imports = &.{.{
                .name = "ghostty-vt",
                .module = ghostty.module("ghostty-vt"),
            }},
        }),
    });
    wasm.entry = .disabled;
    wasm.rdynamic = true;
    wasm.export_memory = true;

    const web_assets = b.addWriteFiles();
    const jetbrains_mono_nerd_font = b.dependency("jetbrains_mono_nerd_font", .{});
    _ = web_assets.addCopyDirectory(b.path("web"), "", .{ .exclude_extensions = &.{".woff2"} });
    _ = web_assets.addCopyFile(b.path("node_modules/fzstd/esm/index.mjs"), "fzstd.js");
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
    _ = web_assets.addCopyFile(wasm.getEmittedBin(), "terminal.wasm");

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
            .imports = &.{.{
                .name = "web_assets",
                .module = assets_module,
            }},
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
    const e2e_step = b.step("e2e", "Run the physical-GPU browser-to-PTY end-to-end test");
    e2e_step.dependOn(&e2e_cmd.step);

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
    const test_step = b.step("test", "Run unit and browser end-to-end tests");
    test_step.dependOn(&run_protocol_tests.step);
    test_step.dependOn(&run_vfs_tests.step);
    test_step.dependOn(&e2e_cmd.step);
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
