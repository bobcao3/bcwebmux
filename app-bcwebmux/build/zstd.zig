// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

const std = @import("std");

const common_sources = [_][]const u8{
    "lib/common/debug.c",
    "lib/common/entropy_common.c",
    "lib/common/error_private.c",
    "lib/common/fse_decompress.c",
    "lib/common/xxhash.c",
    "lib/common/zstd_common.c",
};

const threading_sources = [_][]const u8{
    "lib/common/pool.c",
    "lib/common/threading.c",
};

const compress_sources = [_][]const u8{
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
};

// Disable the optional assembly below for reproducible x86_64/aarch64 builds
// through the same C source set.
const decompress_sources = [_][]const u8{
    "lib/decompress/huf_decompress.c",
    "lib/decompress/zstd_ddict.c",
    "lib/decompress/zstd_decompress.c",
    "lib/decompress/zstd_decompress_block.c",
};

pub fn add(
    b: *std.Build,
    dep: *std.Build.Dependency,
    target: std.Build.ResolvedTarget,
    optimize: std.lang.Optimize,
) *std.Build.Step.Compile {
    const module = b.createModule(.{
        .target = target,
        .optimize = optimize,
        .link_libc = true,
        .pic = true,
    });
    module.addIncludePath(dep.path("lib"));
    module.addIncludePath(dep.path("lib/common"));
    for (common_sources ++ threading_sources ++ compress_sources ++ decompress_sources) |source| {
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

/// Decompression-only zstd for the freestanding terminal WASM, which has no
/// libc: `libc_include` declares the few <string.h> routines zstd calls, and
/// every context must be created with ZSTD_customMem.
pub fn addWasmDecoder(
    b: *std.Build,
    dep: *std.Build.Dependency,
    target: std.Build.ResolvedTarget,
    optimize: std.lang.Optimize,
    libc_include: std.Build.LazyPath,
) *std.Build.Step.Compile {
    const module = b.createModule(.{
        .target = target,
        .optimize = optimize,
    });
    module.addIncludePath(libc_include);
    module.addIncludePath(dep.path("lib"));
    module.addIncludePath(dep.path("lib/common"));
    for (common_sources ++ decompress_sources) |source| {
        module.addCSourceFile(.{
            .file = dep.path(source),
            .flags = &.{
                "-std=c99",
                // Hidden symbols stay out of the module's export list, so
                // unused zstd entry points are dropped at link time.
                "-fvisibility=hidden",
                "-DZSTDLIB_VISIBLE=",
                "-DZSTDERRORLIB_VISIBLE=",
                "-DXXH_NO_STDLIB",
                // No libc allocator to fall back on: contexts made without
                // ZSTD_customMem fail to allocate instead of linking malloc.
                "-DZSTD_DEPS_MALLOC",
                "-DZSTD_malloc(s)=((void)(s), (void *)0)",
                "-DZSTD_calloc(n,s)=((void)(n), (void)(s), (void *)0)",
                "-DZSTD_free(p)=((void)(p))",
                // Size over peak throughput, like the rest of the size-optimized module.
                "-DHUF_FORCE_DECOMPRESS_X1",
                "-DZSTD_FORCE_DECOMPRESS_SEQUENCES_SHORT",
            },
        });
    }
    return b.addLibrary(.{
        .name = "zstd-wasm-decoder",
        .linkage = .static,
        .root_module = module,
    });
}
