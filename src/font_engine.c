/* SPDX-License-Identifier: MIT */
/* Copyright (c) 2026 Cheng Cao */

#include <stddef.h>

extern void *bc_font_alloc(size_t size);
extern void bc_font_free(void *pointer);

static void *bc_memset(void *dest, int value, size_t size) {
    unsigned char *out = (unsigned char *)dest;
    while (size--) *out++ = (unsigned char)value;
    return dest;
}

static void *bc_memcpy(void *dest, const void *source, size_t size) {
    unsigned char *out = (unsigned char *)dest;
    const unsigned char *in = (const unsigned char *)source;
    while (size--) *out++ = *in++;
    return dest;
}

#define KB_TEXT_SHAPE_NO_CRT
#define KBTS_MEMSET bc_memset
#define KBTS_MEMCPY bc_memcpy
#define KBTS_MALLOC(data, size) bc_font_alloc(size)
#define KBTS_FREE(data, pointer) bc_font_free(pointer)
#define KB_TEXT_SHAPE_IMPLEMENTATION
#include "kb_text_shape.h"

#define STBTT_malloc(size, user) bc_font_alloc(size)
#define STBTT_free(pointer, user) bc_font_free(pointer)
#define STBTT_assert(condition) ((void)0)
#define STBTT_ifloor(value) ((int)__builtin_floor(value))
#define STBTT_iceil(value) ((int)__builtin_ceil(value))
#define STBTT_sqrt(value) __builtin_sqrt(value)
#define STBTT_pow(value, power) __builtin_pow(value, power)
#define STBTT_fmod(value, modulus) __builtin_fmod(value, modulus)
#define STBTT_cos(value) __builtin_cos(value)
#define STBTT_acos(value) __builtin_acos(value)
#define STBTT_fabs(value) __builtin_fabs(value)
#define STBTT_strlen(value) __builtin_strlen(value)
#define STBTT_memcpy bc_memcpy
#define STBTT_memset bc_memset
#define STB_TRUETYPE_IMPLEMENTATION
#include "stb_truetype.h"
