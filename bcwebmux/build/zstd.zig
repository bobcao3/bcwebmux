// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");

const source_files = [_][]const u8{
    // common
    "lib/common/debug.c",
    "lib/common/entropy_common.c",
    "lib/common/error_private.c",
    "lib/common/fse_decompress.c",
    "lib/common/pool.c",
    "lib/common/threading.c",
    "lib/common/xxhash.c",
    "lib/common/zstd_common.c",
    // compression
    "lib/compress/fse_compress.c",
    "lib/compress/hist.c",
    "lib/compress/huf_compress.c",
    "lib/compress/zstd_compress.c",
    "lib/compress/zstd_compress_literals.c",
    "lib/compress/zstd_compress_sequences.c",
    "lib/compress/zstd_compress_superblock.c",
    "lib/compress/zstd_double_fast.c",
    "lib/compress/zstd_fast.c",
    "lib/compress/zstd_lazy.c",
    "lib/compress/zstd_ldm.c",
    "lib/compress/zstd_opt.c",
    "lib/compress/zstd_preSplit.c",
    "lib/compress/zstdmt_compress.c",
    // decompression; disable the optional assembly below for reproducible
    // x86_64/aarch64 builds through the same C source set.
    "lib/decompress/huf_decompress.c",
    "lib/decompress/zstd_ddict.c",
    "lib/decompress/zstd_decompress.c",
    "lib/decompress/zstd_decompress_block.c",
};

pub fn add(
    b: *std.Build,
    dep: *std.Build.Dependency,
    target: std.Build.ResolvedTarget,
    optimize: std.builtin.OptimizeMode,
) *std.Build.Step.Compile {
    const module = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    module.addIncludePath(dep.path("lib"));
    module.addIncludePath(dep.path("lib/common"));
    for (source_files) |source| {
        module.addCSourceFile(.{
            .file = dep.path(source),
            .flags = &.{
                "-std=c99",
                "-DZSTD_DISABLE_ASM",
                "-DZSTD_MULTITHREAD=0",
            },
        });
    }
    return b.addLibrary(.{
        .name = "zstd",
        .linkage = .static,
        .root_module = module,
    });
}

pub fn addCompressor(
    b: *std.Build,
    dep: *std.Build.Dependency,
    optimize: std.builtin.OptimizeMode,
) *std.Build.Step.Compile {
    const module = b.createModule(.{
        .target = b.graph.host,
        .optimize = optimize,
        .root_source_file = b.path("toolchains/zstd_compress.zig"),
        .link_libc = true,
    });
    module.addIncludePath(dep.path("lib"));
    module.linkLibrary(add(b, dep, b.graph.host, optimize));
    return b.addExecutable(.{
        .name = "bcwebmux-zstd-compress",
        .root_module = module,
    });
}
