/* SPDX-License-Identifier: MIT */
/* Copyright (c) 2026 Cheng Cao */

/* The terminal WASM is freestanding. These are the only <string.h> routines
 * the vendored zstd decoder calls; Zig's compiler_rt defines them. */
#ifndef BC_ZSTD_LIBC_STRING_H
#define BC_ZSTD_LIBC_STRING_H

#include <stddef.h>

void *memcpy(void *restrict dest, const void *restrict source, size_t size);
void *memmove(void *dest, const void *source, size_t size);
void *memset(void *dest, int value, size_t size);
int memcmp(const void *left, const void *right, size_t size);

#endif
