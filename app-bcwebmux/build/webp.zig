// SPDX-License-Identifier: MIT
// Copyright (c) 2026 Cheng Cao

//! libwebp's encoder and decoder as one static library, with libwebp's own
//! runtime CPU dispatch: every file sees WEBP_HAVE_<ISA> so the plain C init
//! functions reference each SIMD variant, and only the variant files are
//! compiled for that ISA, so a baseline CPU never executes them. Source lists
//! follow the pinned release's Makefile.am files.

const std = @import("std");

const sharpyuv_sources = [_][]const u8{
    "sharpyuv/sharpyuv.c",
    "sharpyuv/sharpyuv_cpu.c",
    "sharpyuv/sharpyuv_csp.c",
    "sharpyuv/sharpyuv_dsp.c",
    "sharpyuv/sharpyuv_gamma.c",
};

const dsp_sources = [_][]const u8{
    "src/dsp/alpha_processing.c",
    "src/dsp/cost.c",
    "src/dsp/cpu.c",
    "src/dsp/dec.c",
    "src/dsp/dec_clip_tables.c",
    "src/dsp/enc.c",
    "src/dsp/filters.c",
    "src/dsp/lossless.c",
    "src/dsp/lossless_enc.c",
    "src/dsp/rescaler.c",
    "src/dsp/ssim.c",
    "src/dsp/upsampling.c",
    "src/dsp/yuv.c",
};

const enc_sources = [_][]const u8{
    "src/enc/alpha_enc.c",
    "src/enc/analysis_enc.c",
    "src/enc/backward_references_cost_enc.c",
    "src/enc/backward_references_enc.c",
    "src/enc/config_enc.c",
    "src/enc/cost_enc.c",
    "src/enc/filter_enc.c",
    "src/enc/frame_enc.c",
    "src/enc/histogram_enc.c",
    "src/enc/iterator_enc.c",
    "src/enc/near_lossless_enc.c",
    "src/enc/picture_csp_enc.c",
    "src/enc/picture_enc.c",
    "src/enc/picture_psnr_enc.c",
    "src/enc/picture_rescale_enc.c",
    "src/enc/picture_tools_enc.c",
    "src/enc/predictor_enc.c",
    "src/enc/quant_enc.c",
    "src/enc/syntax_enc.c",
    "src/enc/token_enc.c",
    "src/enc/tree_enc.c",
    "src/enc/vp8l_enc.c",
    "src/enc/webp_enc.c",
};

// The worker decodes WebP sources before clamping image resolution.
const dec_sources = [_][]const u8{
    "src/dec/alpha_dec.c",
    "src/dec/buffer_dec.c",
    "src/dec/frame_dec.c",
    "src/dec/idec_dec.c",
    "src/dec/io_dec.c",
    "src/dec/quant_dec.c",
    "src/dec/tree_dec.c",
    "src/dec/vp8_dec.c",
    "src/dec/vp8l_dec.c",
    "src/dec/webp_dec.c",
};

const utils_sources = [_][]const u8{
    "src/utils/bit_reader_utils.c",
    "src/utils/bit_writer_utils.c",
    "src/utils/color_cache_utils.c",
    "src/utils/filters_utils.c",
    "src/utils/huffman_encode_utils.c",
    "src/utils/huffman_utils.c",
    "src/utils/palette.c",
    "src/utils/quant_levels_dec_utils.c",
    "src/utils/quant_levels_utils.c",
    "src/utils/random_utils.c",
    "src/utils/rescaler_utils.c",
    "src/utils/thread_utils.c",
    "src/utils/utils.c",
};

const Variant = struct {
    flags: []const []const u8,
    sources: []const []const u8,
};

const x86_variants = [_]Variant{
    .{ .flags = &.{"-msse2"}, .sources = &.{
        "sharpyuv/sharpyuv_sse2.c",
        "src/dsp/alpha_processing_sse2.c",
        "src/dsp/cost_sse2.c",
        "src/dsp/dec_sse2.c",
        "src/dsp/enc_sse2.c",
        "src/dsp/filters_sse2.c",
        "src/dsp/lossless_enc_sse2.c",
        "src/dsp/lossless_sse2.c",
        "src/dsp/rescaler_sse2.c",
        "src/dsp/ssim_sse2.c",
        "src/dsp/upsampling_sse2.c",
        "src/dsp/yuv_sse2.c",
    } },
    .{ .flags = &.{"-msse4.1"}, .sources = &.{
        "src/dsp/alpha_processing_sse41.c",
        "src/dsp/dec_sse41.c",
        "src/dsp/enc_sse41.c",
        "src/dsp/lossless_enc_sse41.c",
        "src/dsp/lossless_sse41.c",
        "src/dsp/upsampling_sse41.c",
        "src/dsp/yuv_sse41.c",
    } },
    .{ .flags = &.{"-mavx2"}, .sources = &.{
        "src/dsp/lossless_avx2.c",
        "src/dsp/lossless_enc_avx2.c",
    } },
};

// Every AArch64 CPU has NEON, so libwebp selects it without detection.
const aarch64_variants = [_]Variant{
    .{ .flags = &.{}, .sources = &.{
        "sharpyuv/sharpyuv_neon.c",
        "src/dsp/alpha_processing_neon.c",
        "src/dsp/cost_neon.c",
        "src/dsp/dec_neon.c",
        "src/dsp/enc_neon.c",
        "src/dsp/filters_neon.c",
        "src/dsp/lossless_enc_neon.c",
        "src/dsp/lossless_neon.c",
        "src/dsp/rescaler_neon.c",
        "src/dsp/upsampling_neon.c",
        "src/dsp/yuv_neon.c",
    } },
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
    module.addIncludePath(dep.path(""));
    module.addIncludePath(dep.path("src"));
    const arch = target.result.cpu.arch;
    const variants: []const Variant = if (arch == .x86_64)
        &x86_variants
    else if (arch == .aarch64)
        &aarch64_variants
    else
        &.{};
    const base_flags: []const []const u8 = if (arch == .x86_64)
        &.{ "-std=c99", "-DWEBP_HAVE_SSE2", "-DWEBP_HAVE_SSE41", "-DWEBP_HAVE_AVX2" }
    else
        &.{"-std=c99"};
    for (sharpyuv_sources ++ dsp_sources ++ enc_sources ++ dec_sources ++ utils_sources) |source| {
        module.addCSourceFile(.{ .file = dep.path(source), .flags = base_flags });
    }
    for (variants) |variant| {
        const flags = std.mem.concat(b.allocator, []const u8, &.{ base_flags, variant.flags }) catch @panic("OOM");
        for (variant.sources) |source| {
            module.addCSourceFile(.{ .file = dep.path(source), .flags = flags });
        }
    }
    return b.addLibrary(.{
        .name = "webp",
        .linkage = .static,
        .root_module = module,
    });
}
