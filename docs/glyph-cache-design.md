# Glyph cache design

## Requirements

1. Each glyph slot on the cache represents exactly 1 on-screen cell.
2. Safety ceilings should be derived from hardware capabilities + settings + clamped to a absolute max, shoving 32K safety ceiling onto devices that will never display this much is garbage.
3. Notice how *it is mathematically impossible* to occupy a glyph cache larger than screen resolution, unless the viewport changes size.
4. Wide-faces always are still laid out on cells in a terminal, a wide-face should simply occupy multiple contiguous glyph slots in the cache.
5. Cache size should be bounded by max glyphs displayable on screen, and only bumped up, never shrinks, as viewports resizes.
6. Updating render settings necessatates recompute of these constraints and sizing.
7. Glyph cache can be expanded and shared between terminals, the max size grows with number of running terminals, until reaching device limits or safety ceiling.

## Design

The page has one renderer, device/context, R8 atlas, and partition allocator. Each live
terminal has one libghostty backend, local glyph-key mappings, and one atlas reservation.
Switching terminals changes only active frame state. Disposal releases the reservation and
terminal allocations without shrinking the physical texture.

For terminal `i` in one render-settings epoch:

```text
visible_i = columns_i * rows_i
capacity_i = max observed visible_i
reserved = sum capacity_i over live terminals
```

Ordinary resize only raises `capacity_i`. A font, ligature, physical-metric, rasterizer, or
cache-budget change starts a settings epoch, invalidates mappings, and resets every
`capacity_i` to its current visible size.

The atlas always stores one byte of coverage per physical cell-sized R8 slot. Canvas text is
converted from Canvas alpha to R8; color glyphs are unsupported. Wide glyphs and ligatures
reserve consecutive slots, one per occupied terminal cell. Uploads split only where a run
crosses a texture row.

For cell width `W`, height `H`, maximum texture dimension `D`, configured budget `B`, absolute
budget `A`, and protocol limit `P`:

```text
slot_bytes = W * H
hardware_slots = floor(D / W) * floor(D / H)
budget_slots = floor(min(B, A) / slot_bytes)
slot_limit = min(hardware_slots, budget_slots, P)
```

Logical partitions are contiguous and deterministic. Growth or disposal may repack them;
any moved partition receives a new generation. Texture padding is never reservable. Physical
allocation grows to committed demand and does not use the absolute ceiling as a requested
size.

Capacity changes follow `plan -> allocate -> commit`. Checked capacity and allocation errors
occur before mutation. The commit installs prevalidated partitions through
`term_set_glyph_partition(base, capacity, columns, generation)`. Unexpected commit failures
close the renderer. There is no partition eviction, partial admission, or silent degradation.

A submission is accepted only for the active terminal and committed generation. Every cell,
bitmap upload, and Canvas request must remain inside that terminal's partition. Cell glyph
zero means empty; nonzero values are absolute atlas slot plus one.

Verification covers WebGPU and WebGL2, STB and Canvas R8 rasterization, DPR 4, wide spans,
resize high-water behavior, settings recomputation, multi-terminal sharing,
partition reuse/relocation, deterministic capacity rollback, and ABI validation.
