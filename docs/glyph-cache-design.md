# Glyph cache design

## Requirements

1. Each glyph slot on the cache represents exactly 1 on-screen cell.
2. Safety ceilings should be derived from hardware capabilities + settings +
   clamped to a absolute max, shoving 32K safety ceiling onto devices that will
   never display this much is garbage.
3. Notice how _it is mathematically impossible_ to occupy a glyph cache larger
   than screen resolution, unless the viewport changes size.
4. Wide-faces always are still laid out on cells in a terminal, a wide-face
   should simply occupy multiple contiguous glyph slots in the cache.
5. Cache size should be bounded by max glyphs displayable on screen, and only
   bumped up, never shrinks, as viewports resizes.
6. Updating render settings necessatates recompute of these constraints and
   sizing.
7. Terminals share the physical cache. Inactive terminals must not consume
   full-screen GPU reservations.

## Design

The page has one renderer, device/context, R8 atlas, and partition allocator.
Each live terminal has one libghostty backend, local glyph-key mappings, and one
logical capacity. Only the active terminal owns the physical slot space.
Switching ownership increments the incoming terminal's generation and
invalidates its glyph mappings, so the incoming terminal rebuilds glyphs before
drawing. Disposal releases terminal allocations without shrinking the physical
textures.

For terminal `i` in one render-settings epoch:

```text
visible_i = columns_i * rows_i
capacity_i = max observed visible_i
reserved = capacity_active
```

Ordinary resize only raises `capacity_i`. A font, ligature, physical-metric,
rasterizer, or cache-budget change starts a settings epoch, invalidates
mappings, and resets every `capacity_i` to its current visible size.

The renderer separates logical reservations from physical texture allocation.
The geometry planner in
[`GlyphAtlasLimits.js`](../wgpuTerminal/src/browser/render/GlyphAtlasLimits.js)
defines the fixed pixel width, initial allocation, and hardware and byte limits.
The planner packs whole cell tiles across the fixed width and leaves unused
pixels at the right edge. Window resizing changes the height ceiling, never the
page width. Texture arrays add pages when a full screen exceeds the GPU's
maximum page height. Physical glyph cells wider or taller than one page cannot
fit.

The R8 coverage texture and RGBA color overlay start with partial-screen
allocations and grow independently. Each texture doubles its height when an
upload exceeds allocated capacity, up to the committed reservation ceiling. Once
a texture needs multiple pages, the renderer allocates whole array layers.
Growth preserves existing pixels before the renderer uploads new pixels. The
configured byte budget limits the R8 texture, including right-edge padding; the
RGBA overlay and slot mapping require additional memory.

Canvas rasterization retains R8 coverage for every glyph. The renderer packs
colored tiles into a separate compact RGBA slot space and stores the association
in an integer mapping texture. The shader composites the mapped overlay on top
of coverage, preserving fonts that mix colored and foreground-colored layers.
Monochrome uploads neither consume color slots nor force RGBA growth. Reusing a
coverage slot releases the previous color association. kb-stb has no color
support. Wide glyphs and ligatures reserve consecutive coverage slots, one per
occupied terminal cell; color tiles need not remain consecutive.

The backend retains historical glyph entries until the logical partition fills.
Before reusing slots, the backend clears its glyph mappings and rebuilds every
visible row. A full-screen reservation guarantees enough slots for the rebuild,
even when every cell needs a distinct entry.

Logical partitions reuse the same base slot. The renderer accepts submissions
only from the active owner and committed generation. Texture padding is never
reservable. Logical admission checks the active terminal's full-screen
requirement, while physical allocation follows upload demand and does not use
the absolute ceiling as a requested size.

Reservation changes follow `plan -> allocate -> commit`. The planner checks
capacity before mutation; later demand-driven GPU allocations can still fail.
The commit installs prevalidated partitions through
`term_set_glyph_partition(base, capacity, columns, generation)`. Unexpected
commit failures close the renderer. Ownership changes invalidate inactive
caches; the renderer never silently discards glyphs from the submitted frame.

A submission is accepted only for the active terminal and committed generation.
Every cell, bitmap upload, and Canvas request must remain inside that terminal's
partition. Cell glyph zero means empty; nonzero values are absolute atlas slot
plus one.

Verification covers WebGPU and WebGL2, STB and Canvas R8 rasterization, wide
spans, resize high-water behavior, settings recomputation, multi-terminal
sharing, ownership changes, cross-page growth, deterministic capacity rollback,
and ABI validation.
