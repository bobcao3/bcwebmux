# Kitty graphics and client rendering design

Status: proposal, not implemented. Based on Ghostty `b32f20f3e8d25bb925ec545c54498e93518e7ced`. All source paths below are repository-root-relative.

This includes the prerequisite WASM/JS boundary refactor in section 7. The target is one client frame pipeline for text and graphics, not a second renderer bolted onto the current one. Native image admission/checkpoint rules remain independent of presentation.

## 1. Architecture and boundaries

**The native terminal server must not decode image pixels.** It owns protocol semantics and preserves encoded payloads, image dimensions, placements, and incomplete transmissions. Browser APIs decode pixels; WebGPU/WebGL materialize textures. Decode completion is presentation state, not a terminal protocol event.

Use Ghostty for parsing, IDs, command execution, cursor effects, scrolling, deletion, relative placements, and Unicode placeholder interpretation. Extend its image storage with an **opaque payload mode**, used by both native and WASM cores. Current Ghostty expects decoded pixels, so `+kitty-graphics` alone is insufficient.

No native or WASM PNG decoder is added. Do not duplicate the Kitty parser in JS, put images in the glyph atlas, use a DOM overlay, or reconstruct placements by replaying old commands onto restored text state.

### Metadata inspection is not pixel decoding

The server needs dimensions to implement natural sizing, cursor movement, cropping, and scrolling without a connected browser. Parse PNG signature/IHDR metadata synchronously, without decoding pixels. For zlib-wrapped PNG, allow a bounded header probe that inflates only enough output to inspect IHDR; it must not decode raster data or PNG filters. Zlib-wrapped raw images declare their dimensions in protocol controls.

If even limited container inflation is prohibited, compressed PNG requires a different geometry contract. Deferring authoritative dimensions to whichever browser happens to be connected is not a correct headless design.

### Initial profile

- Direct raw formats supported by the pinned core, PNG, and zlib compression.
- Chunked transmission, queries, transmit-only, transmit-and-display, replacement, deletion.
- Pinned, virtual/Unicode, and relative placements, with cropping, offsets, z-order, both screens, scrollback, resize, and reset.
- Tail reconnect, checkpoint recovery, new viewers, background cores, and GPU reconstruction.
- No file, temporary-file, shared-memory, or URL transmission. Keep `.direct` policy on both cores.
- Animation is a later milestone. Explicitly reject its actions until the encoded-recipe implementation and checkpoint form are complete.

## 2. Ownership and identities

| Owner | State | Lifetime |
| --- | --- | --- |
| Native/WASM Ghostty | Encoded payloads, dimensions, image/placement maps, incomplete transmissions | Session/core |
| Checkpoint | Portable metadata and immutable encoded blobs | Capture/replay transaction |
| Browser decoder | Copied encoded source, decode task, bitmap or RGBA output | Bounded presentation job |
| Browser renderer | Textures, bindings, visible draw list | Renderer/device generation |

The WASM terminal also stores opaque payloads. It does not wait for browser PNG decode or require decoded pixels copied back into linear memory. GPU eviction cannot delete a logical terminal image. Cached textures cannot establish that a placement is still valid.

Use two kinds of identity:

- **Local resource identity:** `(coreEpoch, screen, imageId, imageGeneration)`. Use BigInt or paired u32 words for u64 values across JS, never lossy Numbers.
- **Portable payload identity:** SHA-256 over a versioned descriptor plus encoded bytes. Include format, compression, dimensions, and bytes. Local Ghostty generation counters are not portable content hashes.

Texture keys add `decodePolicyVersion` and `deviceEpoch` to the payload digest. Identical encoded content can share resources across placements and shadow cores, with separate references per consumer. Different encodings of identical visible pixels need not deduplicate.

Retain encoded sources after pixel-cache eviction and device loss. A texture-only cache cannot restore logical state or reconstruct a lost device.

## 3. File and translation-unit hierarchy

Use direct imports of concrete modules. There is no `graphics/root.zig` or directory-level re-export layer.

### Checkpoint codec hierarchy

The dependency hierarchy mirrors the data hierarchy:

```text
Terminal checkpoint — common/terminal/TerminalCheckpoint.zig
├── Ghostty VT snapshot — @import("ghostty-vt").snapshot
└── Graphics snapshot — common/terminal/checkpoint/GraphicsSnapshot.zig
    ├── Encoded images — checkpoint/graphics/EncodedImages.zig
    ├── Placements — checkpoint/graphics/Placements.zig
    └── In-progress transmissions — checkpoint/graphics/InProgressTransmissions.zig
```

The corresponding repository tree is:

```text
common/terminal/
├── TerminalCheckpoint.zig
├── checkpoint/
│   ├── GraphicsSnapshot.zig
│   └── graphics/
│       ├── EncodedImages.zig
│       ├── Placements.zig
│       └── InProgressTransmissions.zig
└── graphics/
    ├── GraphicsPayload.zig
    ├── ImageHeader.zig
    ├── GraphicsState.zig
    └── GraphicsFrame.zig
```

`checkpoint/graphics/` contains serialization code. The sibling `graphics/` contains runtime payload/state/rendering code. Do not mix checkpoint codecs with renderer caches.

| Translation unit | Owns | Does not own |
| --- | --- | --- |
| `TerminalCheckpoint.zig` | Compound envelope/version, section validation, atomic capture/restore ordering, coordination with Ghostty's VT codec | Graphics record details or a new copy of Ghostty's VT serializer |
| `checkpoint/GraphicsSnapshot.zig` | Both-screen graphics records, ID counters, child-codec coordination, cross-record validation, restore order | Outer checkpoint framing or GPU state |
| `checkpoint/graphics/EncodedImages.zig` | Image metadata, immutable encoded blobs, digests, resource accounting | Placements or browser pixels |
| `checkpoint/graphics/Placements.zig` | Placement keys/geometry, portable anchors, parent validation, tracked-pin reconstruction | Pixel payloads or terminal stream replay |
| `checkpoint/graphics/InProgressTransmissions.zig` | First-command metadata and accumulated completed transmission chunks | The unfinished escape-sequence suffix handled by Ghostty stream continuation |

Every local TU contains codec implementation and tests, not just aliases. `TerminalCheckpoint.zig` imports Ghostty's VT codec directly and `checkpoint/GraphicsSnapshot.zig`; that graphics codec imports its three children directly. There is no local `GhosttySnapshot.zig` wrapper. Native and WASM build modules import the same concrete checkpoint implementation so the schema cannot drift.

Atomicity stays with the parent: children decode into staged state and do not publish partially restored state to the active terminal. Runtime payload structures are shared with the codecs through direct imports.

## 4. Runtime modules and structs

The following are logical schemas. Wire and checkpoint codecs serialize explicit integer widths and little-endian fields; never memcpy native structs to the wire.

### `graphics/GraphicsPayload.zig`

Owns immutable payloads, reference accounting, digests, and resource reservations. Base64 is decoded and chunks assembled; PNG raster and compressed image bodies remain encoded.

```zig
const EncodedImage = struct {
    format: PixelFormat,
    compression: enum { none, zlib },
    width: u32,
    height: u32,
    bytes: []const u8,
    digest: [32]u8,
    decoded_reservation: u64,
};

const GraphicsLimits = struct {
    max_dimension: u32,
    max_image_decoded_bytes: u64,
    max_total_decoded_reservation: u64,
    max_total_encoded_bytes: u64,
    max_loading_bytes: u64,
    max_images: u32,
    max_placements: u32,
    max_relative_depth: u16,
};
```

Track actual encoded bytes and expected decoded/GPU capacity separately. Compressed images must not evade admission limits. Uncompressed raw payload length is checked exactly; full validation of compressed raster data belongs to the browser decoder, with bounded output.

### `graphics/ImageHeader.zig`

Small shared metadata inspector. Validate PNG signature, IHDR length/CRC and legal fields, dimensions, supported profile, and overflow-safe size arithmetic. Do not trust command-provided PNG dimensions over IHDR. Limit input work/output/allocations for the compressed-header probe. No raster inflation, filters, pixel conversion, or native image decoder.

Define unsupported/APNG behavior explicitly; browser animation must not accidentally become Kitty animation semantics.

### `graphics/GraphicsState.zig`

Adapter to Ghostty's image and placement maps, not another scene database. Owns shared policy, resource identity, payload references, and core epoch.

```zig
const ImageResource = struct {
    handle: u32,
    screen: u32,
    image_id: u32,
    generation: u64,
    payload_digest: [32]u8,
    payload: *const EncodedImage,
};
```

No asynchronous protocol-decode command, native decode receipts, or parser suspension is necessary. Logical image admission is complete before any browser materialization.

### `graphics/GraphicsFrame.zig`

Uses Ghostty crop/sizing helpers, parent chains, tracked pins, and placeholder iterators to build a bounded visible draw list. Do not import Ghostty's native renderer/platform dependencies into WASM.

```zig
const ImageDraw = struct {
    resource_handle: u32,
    layer: enum(u32) { below_cell_bg, below_text, above_text },
    z: i32,
    stable_order: u32,
    dest: RectF32,
    source: RectF32,
    clip: RectF32,
};

const GraphicsFrame = struct {
    revision: u64,
    draws: []const ImageDraw,
};
```

Initially produce a complete placement list when dirty rather than placement deltas. Transfer payload bytes only on a cache miss, not once per placement/frame. Resource lookup must allow an unchanged logical image to be decoded again after cache eviction.

## 5. Ghostty extension and protocol semantics

Maintain the extension in a pinned fork/upstream commit, never by mutating `zig-pkg/` caches during builds.

- `graphics_image.zig`: opaque encoded representation and metadata-only finalization. Preserve the existing decoded mode for upstream native Ghostty.
- `graphics_storage.zig`: encoded-byte/decoded-reservation accounting and payload ownership. Distinguish logical admission from renderer readiness; retain IDs, deletion, placement, and eviction semantics.
- `graphics_exec.zig`: admit metadata-validated opaque images and apply cursor/placement effects immediately. Enforce the supported command profile.
- Terminal options: select opaque mode and identical metadata/limit policy in native and WASM cores.
- Expose concrete payload/placement APIs required by the shared adapter. Keep eager native-renderer assumptions isolated from the opaque path.

The existing `Image.data.pending` completion token is a useful stale-work fencing pattern, not a complete encoded-image storage design. Do not model an admitted opaque image as an unfinished transmission merely because no viewer has decoded it.

### Error policy

Native code can reject malformed controls/base64, invalid headers, impossible dimensions, unsupported media, and resource-limit violations. Without decoding pixels, it cannot prove that an entire PNG raster/deflate body is valid.

Success therefore means **accepted into logical terminal state**, not successfully rendered by a browser. Queries follow the same admission policy. A later browser decode failure is local presentation failure: memoize the failed payload, draw nothing for it, emit a bounded diagnostic, and leave authoritative cursor/placement state unchanged. Never emit late or duplicate PTY responses from viewers.

This differs from Ghostty's eager raster-validation errors and is part of the negotiated profile. Exact eager decode-validation semantics cannot be promised while prohibiting native pixel decoding. A browser never becomes the session's authoritative validator.

## 6. Browser materialization

### State machine

```text
unrequested -> queued -> decoding -> decoded -> uploaded
                         |             |          |
                         +-> failed    +----------+-> evicted/reconstructible
```

Keep this separate from terminal input application. `TerminalCore.write()` stays synchronous for logical processing. Event ACK still means bytes applied to terminal state, not pixels ready. No decode-driven protocol barriers, per-attachment async parser queues, or image-decode-driven reconnect are introduced.

### Decode pipeline

1. A draw list references a resource absent from the texture cache.
2. `ImageDecodePool` reserves bounded source/decoded bytes and actual-job or bounded queue capacity, prioritizing visible images. Offscreen images can stay encoded; queued references alone do not require payload copies.
3. After admission, `TerminalImageStore` asks the core bridge to copy the encoded payload into independently owned JS storage. Never retain a borrowed WASM view across await or memory growth. Release the reservation if the resource became stale or copying fails.
4. For zlib bodies, consume `DecompressionStream("deflate")` in bounded chunks in a worker; enforce the output cap while reading. Never first construct an unbounded decompressed Blob. Any compatibility fallback is browser-side and bounded.
5. Decode PNG through `createImageBitmap` with explicit orientation, alpha, and color policy, or feature-tested `ImageDecoder`/browser fallback. Raw formats expand to RGBA in the worker for typed-array or ImageData upload.
6. Verify decoded dimensions against admitted metadata and retain the result under the decoded-memory budget. Decode completion only marks presentation dirty; it does not upload or draw from a worker/promise callback.
7. At an eligible scheduler opportunity, upload/install only under still-valid resource/core/device ownership. Prefer direct ImageBitmap GPU upload when it matches the documented convention. OffscreenCanvas normalization/readback is available when needed, not a required round-trip into WASM. Do not refeed protocol bytes or ask the application to retransmit.
8. Close ImageBitmap/VideoFrame objects and release buffers after failure, cancellation, eviction, or stale completion.

Resource access through `TerminalCore` (logical API; exact ABI widths are defined with the implementation):

```text
core.consumeFrame(consumer) -> one synchronous, validated frame including visible image draws
core.copyImageSource(handle, generation) -> owned encoded bytes and metadata, or stale/missing
```

There is no separate graphics-frame polling channel. Source lookup/copy happens after the borrowed frame has been released, before any await; the bridge checks core epoch and resource generation again. A missing/replaced source cancels that request, not the logical frame. Copy once per admitted cache-miss job, not per placement. Do not copy all missing images into an unbounded JS queue before decode admission.

Reset/restore/disposal advances `coreEpoch`. Completion is fenced by core epoch, resource generation/digest, and device epoch. Old work must not install pixels for a reused image ID. Shared jobs hold independent consumer references.

Logical cancellation does not release an actual decode slot until the browser job finishes. Late results are closed/discarded. Memoize failures by digest/policy to avoid retrying each frame. Decoder failure does not alter protocol state.

Keep deferred visible misses as bounded resource references. Job completion, released byte capacity, and visibility/attachment resume trigger one scheduler notification to reconsider them against the retained current draw list; new terminal output is not required. Source copying still revalidates identity. Do not poll a saturated queue or spin on permanently over-budget resources; use a stable budgeted visible working set instead of repeatedly evicting and decoding the same competing images.

## 7. Renderer integration

### 7.1 Why refactor first

The existing bulk frame ABI and dirty-row uploads are worth keeping. The inconsistency is ownership and control flow, not simply the number of WASM exports. Source inspection found:

| Current implementation | Adjustment |
| --- | --- |
| `common/terminal/Wgpu.zig` builds cells/styles, caches/rasterizes text, embeds WGSL, calls `gpu_init`, and calls `gpu_submit` | Keep the CPU frame builder; remove GPU initialization, shader assets, and host submission callbacks from it |
| `Terminal.js`, `TerminalCoreHost.js`, viewport/focus/pointer controllers, and both GPU backends know about WASM exports or raw submission memory | Make `TerminalCore` the only client ABI entry point; controllers use semantic methods and backends receive validated data |
| Both `GpuTerminal.submitWasm` and `WebGlTerminal.submitWasm` walk glyph requests, apply metadata, draw, and manage blink | Move orchestration into one shared presenter; keep only GPU-specific operations in the two backends |
| `FrameScheduler` gates hidden-document work, but each backend independently rearms a blink timer and draws | Give one visibility-aware scheduler exclusive presentation authority |
| The inspected STB branch calls the combined kb-shaping/STB-raster function, while the Canvas branch emits text for `fillText` | Reconcile this implementation gap with the shared kb shaping/layout contract; do not redefine Canvas as a separate layout engine |
| `RendererSubmission.js` scans every cell even for small dirty updates; Canvas masks use per-tile readback; WebGPU stages buffer uploads and copies an offscreen frame to the swapchain | Preserve correctness first, then remove avoidable work with measurements rather than duplicating rendering paths |

These are static source findings, not measured speed or power results. Relevant sources are `common/terminal/Wgpu.zig`'s `submitCached` and, under `wgpuTerminal/src/`, `Terminal.js`'s `_gpuSubmit`, `browser/FrameScheduler.js`, `browser/render/RendererSubmission.js`, `browser/render/CanvasAlphaMask.js`, and both backend `submitWasm`/`draw` methods.

### 7.2 Target ownership: CPU frame preparation versus browser presentation

**WASM interprets terminal state and prepares bounded frame data. JS owns the browser, resource residency, and presentation.** This is not “all rendering in JS,” nor “all rendering in WASM.” kb shaping/layout stays in WASM for both text rasterizers; browser-only operations stay in the browser. The same rule applies to both GPU backends.

| Owner | Authoritative responsibilities | Must not do |
| --- | --- | --- |
| Native/WASM Ghostty and shared graphics code | VT/Kitty parsing, canonical grid, modes, input encoding, selection, scrolling, image admission, placement semantics, checkpoint state | Depend on device capabilities, browser raster validity, or texture residency for protocol outcomes |
| WASM `RenderFrame.zig` (renamed from `Wgpu.zig`) | Derive cells/styles/runs, dirty ranges, optional text mirror, cursor/blink requirements, and visible image geometry from terminal state; shared kb shaping/layout, CPU text caches, and rasterizer-specific mask/drawing batches | Initialize a GPU, contain shaders, schedule frames, decode image pixels, or interpret DOM events |
| JS `TerminalCore` and its `FramePacket.js` decoder | All exports/imports, range/version/generation checks, borrowed-memory lifetime, source copying, semantic client methods | Own a canvas/device or let raw WASM exports escape to browser controllers/backends |
| JS `ViewportController` | DOM/CSS measurement, DPR, physical cell/font metrics, coordinate conversion | Independently derive terminal column widths, image placement semantics, or authoritative session geometry |
| JS `FramePresenter` | Shared frame consumption, glyph partition leases, Canvas text materialization, image-resource requests, current presentation state and ordered draw plan | Parse terminal commands or respecify Ghostty's placement/selection rules |
| JS `FrameScheduler` | Coalescing, visibility, blink/animation deadlines, and permission to present | Infer terminal semantics or rasterize resources |
| JS browser resource modules and GPU backends | Browser font/image APIs, decode jobs, textures/buffers/pipelines, uploads and draws | Read WASM pointers, maintain their own frame clocks, or decide logical image lifetime |

`RenderFrame` is client-only derived state, not another terminal model and not part of the native checkpoint. Do not move native graphics admission into this module. Keep the existing one-core-per-WASM-instance arrangement; merging all cores into a new WASM runtime or introducing shared-memory threading is not required for this refactor.

Keep the compact, bulk numeric streams. Do not expand every cell into a JS object, move shaping loops into JS, or introduce per-glyph WASM calls. A controller may still call a small semantic method such as `core.scrollRows`, `core.pointer`, `core.focus`, or `core.selectRange`; that is a sensible control boundary, unlike a controller knowing ABI pointers and status codes. Font-loading helpers receive narrowly scoped bridge callbacks rather than exposing exports.

### 7.3 One frame path, with explicit borrowed-memory lifetime

Replace the rendering-specific `gpu_init`, `gpu_text_backend`, and `gpu_submit` imports with explicit configuration plus a pull frame interface. Retain bounded host capabilities for terminal replies/effects, logging, and font bytes; this change does not require an asynchronous effects bus.

```text
output / input / resize / scroll
    -> TerminalCore semantic operation -> WASM logical state
    -> FrameScheduler marks core dirty

eligible presentation opportunity
    -> FramePresenter asks TerminalCore.consumeFrame(consumer)
        -> term_frame_prepare: derive packet, reserve one outstanding frame
        -> FramePacket: validate and create borrowed typed views
        -> consumer: consume uploads, update metadata/mirror, retain needed draw records
        -> term_frame_finish(token, accepted), always in finally
    -> admit bounded image-source copies/jobs, outside the borrowed frame
    -> backend.present(current state, ordered layers, presentation time)

decode ready / blink deadline / later animation deadline
    -> FrameScheduler marks presentation dirty
    -> present retained state; no terminal feed or CPU text rebuild
```

`consumeFrame` is one synchronous JS operation, not an async iterator or a general transaction framework. The two ABI calls replace the existing callback's implicit success/clean contract:

- `prepare` returns no-change, failure, or a packet with a token and core/config generations. At most one packet is outstanding per core. No terminal mutation, memory-growing export, source lookup, await, or user callback is allowed while borrowed views are live.
- Validate before applying the packet. Upload APIs must consume their input synchronously, or the presenter must copy into owned bounded staging. Any draw list needed by later blink/decode redraws is copied only when its revision changes; retained scalar metadata contains no WASM pointers.
- `finish(accepted)` cleans the corresponding dirty state only after synchronous consumption succeeds. Rejection invalidates derived caches and requires a full packet next time. Partial GPU updates are never presented after a failed consumption; keep presentation suspended until a complete replacement is accepted. Device loss after acceptance follows the same full-rebuild path.
- Failed preparation must also invalidate partially built caches. Token/epoch mismatch is an error, and `finish` releases the borrow on every path. Do not retry a persistent failure every rAF; report it and wait for explicit recovery/invalidation.
- This local acceptance is not PTY ACK, LIVE readiness, GPU completion, or image pixel readiness. Missing image textures do not reject an otherwise valid packet.

The decoder is renamed/moved from browser `RendererSubmission.js` to `wgpuTerminal/src/FramePacket.js`; it receives explicit expected ABI/config/partition information, not a GPU renderer object. Only `TerminalCore` constructs views of linear memory. Backends accept those already-validated typed views through bounded bulk upload methods and never retain borrowed ones. Do not serialize the frame to JSON or introduce a second complete JS cell mirror.

Put shader/grain presentation assets with the JS renderer, not in the WASM module. Initialize the backend once from its own capabilities and the versioned packet schema. Configure text rasterizer, metrics, and glyph lease explicitly through the core, rather than querying a `gpu_text_backend` host import during core initialization. WASM packet ABI and transport/checkpoint ABI are separate versions.

### 7.4 Shared kb shaping/layout, rasterizers, and resource ownership

Keep the names `kb-stb` and `kb-canvas`: **kb is the shared shaping/layout library; STB and Canvas are rasterization choices**, not alternative layout engines. `webgpu`/`webgl2` remains an independent presentation-backend choice.

- WASM owns terminal cell widths, run boundaries, kb shaping/layout, font selection, glyph IDs/positions, cache keys, and slot assignments for both rasterizers. Separate `FontEngine`'s shared shaping/layout operation from rasterization; a cache miss is shaped once before selecting its pixel-production path.
- `kb-stb` rasterizes the kb result in WASM and exports batched R8 masks. `kb-canvas` exports bounded drawing batches for that same kb result; JS uses Canvas to produce pixels, not to choose another layout. Ligature choices, cluster-to-cell mapping, advances, and offsets must not change when switching rasterizers. Raster antialiasing may differ.
- Ordinary Canvas `fillText` does not accept arbitrary pre-shaped glyph IDs. The Canvas adapter must preserve kb's result, for example by consuming batched glyph outlines and kb positions, rather than silently reshaping the original string. Specify and test this adapter before declaring the refactor complete; do not assume a browser glyph-ID drawing API exists. Font availability must satisfy the shared kb font-data contract; browser-only font discovery/fallback cannot silently become a second shaping authority.
- The presenter owns atlas dimensions, GPU allocation, and per-core **leases** `(base, capacity, columns, generation)`. WASM may pack masks into that explicitly granted slot range, but cannot grow/reassign GPU storage. This intentional storage contract preserves the compact cell ABI; no new per-glyph handle indirection or cross-language eviction protocol is needed.
- JS lease/font changes explicitly invalidate the relevant WASM caches. WASM eviction may reuse slots only at a frame boundary after ensuring the new complete cell references are valid. Ordinary GPU redraws must not mutate these caches. Device reconstruction can request fresh masks from retained terminal/font state; no CPU glyph bitmap checkpoint is needed.
- Before reassigning any lease range or changing atlas layout, invalidate/suspend every affected retained presentation, including inactive cores. Old GPU cell references must never render against reused slots. Resume each affected core only after accepting a full packet with its current lease generation; a blink/decode-only redraw cannot satisfy this requirement.
- `ViewportController` supplies DOM/CSS/DPR measurements; the core supplies common font/layout metrics. Resolve these into one versioned configuration for the core, both rasterizers, backend uniforms, pointer/IME positioning, and text mirror. Baseline, advances, cell dimensions, and clipping follow the shared layout policy, not Canvas text measurement or a separate rasterizer approximation.
- Factor Canvas rasterization out of the backend atlas classes. Read a run's pixels once and pack uploads by atlas row, using the same rectangle-upload interface as WASM masks. Keep rasterizer-specific pixel production separate from shared kb layout and backend-specific upload.

Images follow the same ownership rule, not the same storage layout: WASM exports logical resources/placements; JS materializes browser pixels and owns texture residency. Glyph masks and image textures remain separate because their sizes, formats, decoding, and eviction behavior differ. Use the concrete image modules in section 12, not a generic “all resources” framework.

### 7.5 Shared presenter and sole presentation clock

`FramePresenter.js` absorbs duplicated frame traversal, metadata delivery, Canvas request handling, atlas coordination, and image-layer ordering from `GpuTerminal.js` and `WebGlTerminal.js`. It uses the existing glyph partition/runtime implementations directly. The GPU classes keep actual allocation/upload/pipeline/draw operations; do not add a parallel backend hierarchy beside them.

All callers request work from `FrameScheduler`; backend resize, grain changes, blink, decode completion, attach, and recovery must no longer draw directly. Track two reasons:

- **Core dirty:** a new logical/geometry/text frame may be needed. Prepare at most once for the coalesced work.
- **Presentation dirty:** current GPU data/draw list can be presented with new resources or clock uniforms; do not call WASM merely to blink or display a decoded image.

Use one pending rAF and at most one next animation-deadline timer per visible terminal host. Preserve an explicit immediate-input fast path within the same submission budget; it must not become a second render loop. Blink uses the next visible phase boundary, not a perpetual 60 Hz loop. Later image animation registers its next deadline with this same scheduler and projects missed time on resume instead of rendering every missed frame.

On document hide, host suspension, disposal, or device error, cancel presentation callbacks/timers and retain only dirty reasons. Inactive cores may continue synchronous parsing/ACKs but do not prepare frames, upload, or start visibility-only decode jobs. Already-running browser jobs remain accounted until they actually finish. On visibility/attachment return, coalesce one up-to-date frame; resume never displays a stale core's retained draw list.

If both dirty reasons are pending, consume the latest core frame first, then resolve uploads against that frame's resource references. Decode completion for an older draw list must not resurrect deleted placements. Attach/rollback and device recreation invalidate the presenter's committed frame/base generation and request a full replacement before presentation; cached textures may survive where their identities remain valid, but do not substitute for that replacement.

Stop backend-specific diagnostic rAFs. Optional timing uses the shared scheduler and sampled GPU probes; distinguish CPU preparation, upload/submission, queue-drain delay, and presentation opportunity. None is automatically a measured on-screen latency. At application level, remove unconditional 250 ms status/telemetry polling from `bcwebmux/web/client.js`: update status on events, run a countdown only while needed, and schedule telemetry only while visible/enabled. Transport liveness timers remain separate and necessary.

Default GPU power preference to browser/default policy rather than forcing `high-performance` in both backends; allow an explicit override. This is a hint, not a guarantee of adapter choice or reduced power.

### 7.6 Simplification scope and performance priorities

The required refactor removes render callbacks/shader transfer through WASM, raw ABI access throughout controllers/backends, duplicate backend submission logic, independent blink clocks, and the separate text-versus-graphics orchestration path. It adds **one shared presenter**, reuses the scheduler, and renames two existing implementations. Do not add a service registry, generic command bus, worker-hosted terminal, second scene database, or generalized resource graph.

Preserve demand-driven preparation, dirty-row uploads, bounded glyph caching, and selection-only text-mirror activation. Optimize in this order, with both-backend regression coverage:

1. Eliminate hidden/idle presentation work and duplicate wakeups. This is the prerequisite for animation and meaningful power measurements.
2. Batch Canvas readback/upload; prevent glyph-cache reset based solely on pessimistically counting every dirty text head as a new miss. Check actual misses before bounded eviction. Avoid moving unrelated glyph leases on core removal where practical, without adding a new complex cache policy.
3. Make validation incremental only after generations/base-frame ownership are explicit: validate all ranges/counts/identities, then changed cell records on a delta; validate the complete cell set after reset, attach, or lease changes. Never skip bounds checks or assume an unvalidated previous frame.
4. Compare direct WebGPU buffer writes for small dirty sets against current staging. Prefer direct swapchain rendering for normal presentation instead of the unconditional full-size offscreen copy; provide explicit on-demand capture using the retained last presentation state, including blink/time uniforms. Preserve documented `readPixels` behavior in tests rather than silently capturing a different frame.
5. Measure before adding damage/scissor rendering, placement deltas, texture tiling, or a text-only shader specialization. Full redraw with bounded instances is the simple initial composition model; dirty uploads alone do not reduce fragment work.

Acceptance requires measured preparation/upload bytes, cache-miss work, wakeups and frame times on representative workloads, not a blanket claim that WASM or JS is faster. Include stable idle, blinking prompt, sustained scrolling, cold font cache, many cached cores, image arrival, and DPR 1/2/4. Record backend/device/browser and p50/p95 timings; use platform power tools where available rather than treating FPS as an energy measurement.

### Frame ABI and dirty state

Bump local submission/frame ABI v4 to v5 for the pull-frame contract, core/config/lease generations, graphics revision, draw-list pointer/count, and resource references. Validate pointer/count bounds, finite floats, enums, source bounds, and identity in `FramePacket.js`. Ship one coordinated revision, not permanently supported competing submission paths.

Include graphics dirty state, viewport movement, render metrics, and explicit core invalidation in `Terminal.term_frame_prepare()`'s early-return decision; text/cursor-only dirtiness misses image changes. Browser decode completion is presentation-only dirtiness and redraws the last authoritative draw list without reparsing output.

Suppress placeholder glyph rasterization while retaining codepoints/styles/graphemes in terminal state. Reuse Ghostty's placeholder iterator. Define/test copy and selection behavior; this does not imply image clipboard export.

Resolve semantic geometry using canonical cell sizes, then map it into each viewer's physical grid. Different DPR/font metrics must not change server geometry. Clip to terminal content and adjust source UVs for partially visible images.

### Drawing passes

The current cell shader writes backgrounds, decorations, cursor, and text together as opaque output. Split the graphics path:

1. Default terminal background and existing grain policy.
2. Images with `z < -1073741824`.
3. Effective cell backgrounds, including explicit backgrounds, inverse styles, and selection. Default cells must not unnecessarily erase below-background images.
4. Images with `-1073741824 <= z < 0`.
5. Transparent glyph/decorations/cursor layer.
6. Images with `z >= 0`.
7. Existing UI overlays under their own policy.

Match Ghostty's cursor/selection ordering. Virtual fragments use `z = -1`. Keep explicit/effective-background flags in the style ABI. Sort by z and upstream image tie rules with deterministic residual ties; batching cannot reorder overlapping placements.

Use this one composition model for text-only and graphics frames; skip empty image ranges. Background and foreground can be separate ordered draws in the same GPU render pass, not necessarily separate render targets. Remove the old independent combined-cell path once text-golden parity is established. A later measured text-only optimization must remain an implementation detail of this same frame model, not a second renderer with divergent semantics.

### Resource cache

Separate image textures from glyph atlas slots. Initially allocate one texture per unique resident payload; repeated placements share it. Admission respects conservative device dimensions; later tiling is optional, not silent truncation.

Define and test alpha/color conversion across ImageBitmap and raw uploads. WebGPU uses compatible external-image copies or `queue.writeTexture`; WebGL uses equivalent texture uploads. Sources are local bytes/Blobs, never URLs from terminal output.

Device/context loss invalidates the device epoch and rebuilds pipelines/textures from encoded sources, without resetting the terminal/PTY. Extend current error-only handling. Resource eviction destroys only presentation state. Late upload cannot restore a deleted placement.

## 8. Checkpoint data and restore

```text
TerminalCheckpointV1
  envelope/version/profile, Ghostty ABI
  session generation, event_seq, output_offset
  validated section directory
  Ghostty VT snapshot
  Graphics snapshot
    primary and optional alternate screen
      image/placement allocation counters
      encoded image metadata and blob references
      placements and portable anchors
      deterministic eviction ordering
      optional in-progress transmission
    immutable encoded blob table/data
```

This is the data hierarchy implemented by the TU tree in section 3. Encoded images are stored in native format/compression, not converted to RGBA. No decoded browser pixels, canvases, or GPU objects are serialized.

A placement includes image/placement IDs and internal/external namespace, crop, destination rows/columns, offsets, z, and one of:

- Pin: resident screen/history row ordinal and column.
- Virtual: no direct anchor.
- Relative: parent key and signed cell offsets.

Capture VT and both screens' graphics at one event boundary under the session mutex. Pin coordinates reference captured resident content, not viewport-only coordinates or process pointers. Preserve allocation counters, transient flags, and eviction ordering; reconstruct local generations and derived counts.

In-progress records include first-command parameters, response/quiet IDs, deferred display, and accumulated base64-decoded but otherwise encoded bytes. A checkpoint between completed `m=1` commands needs those bytes. Ghostty's parser continuation only covers a currently unfinished escape sequence.

Restore atomically:

1. Validate envelope, sections, counts, metadata, blob hashes, and budgets.
2. Restore VT into staged terminal state, without replaying continuation yet.
3. Restore image resources/counters and in-progress transmissions.
4. Recreate tracked pins and placements; validate image references, parent chains/cycles/depth.
5. Replay parser continuation exactly once against the fully restored state.
6. Commit logical state and request lazy decoding for visible images.

No pixel decoding is required to capture or logically restore. Do not emit synthetic display commands to recreate placements: that can move the cursor or scroll already-restored text.

### Framing and immutable ownership

Initially retain CHECKPOINT_BEGIN/CHUNK/END, per-chunk CRC, container digest, and credit accounting. Change the opaque checkpoint codec/ABI, not maximum WebSocket frame size. Negotiate a separate bounded compound size; the old 16 MiB VT cap is not an image-storage policy.

Capture immutable/refcounted blobs so a replay survives live replacement/deletion. Capture metadata/pins under lock, then encode/compress from immutable state without holding the session mutex for network IO. Never borrow live mutable Ghostty slices after unlocking.

Use staged bounded restore to avoid repeated complete JS/WASM copies. The old visible core stays alive through validation and replay. Pixel readiness may lag logical commit and is not a LIVE barrier.

## 9. Reconnect behavior

- **Tail resume:** retain core, encoded sources, valid decode jobs, and textures; apply missed events normally. Connection loss alone invalidates none of these.
- **Checkpoint restore:** authoritative metadata goes into a shadow core. Acquire cached source/texture references by payload digest. Replace the visible draw list at commit; never keep old placements simply because textures remain cached.
- **Rollback:** release shadow references only; old resources remain valid.
- **Reload/new viewer:** checkpoint supplies encoded sources, which the browser decodes locally.
- **Context loss:** rebuild presentation resources independently from network recovery.

The first version sends self-contained checkpoints; a cache hit can still avoid decoding/upload even when source bytes are retransmitted. Later negotiate manifest/HAVE/MISSING transfers to save bandwidth. HAVE requires encoded source bytes, not just a texture. Missing blobs must remain obtainable from immutable checkpoint captures after live state changes.

Do not delay input, ACKs, or LIVE for every texture. Undecoded images are temporarily absent; never substitute stale texture content for reused IDs.

## 10. Animation without native pixel decoding

Do not reuse Ghostty's eager RGBA composition path on the server. Introduce bounded immutable composition recipes referencing encoded sources and immutable prior frame versions. Native code validates IDs, dimensions, crop/destination bounds, blend/replace operations, frame control, and reservations without evaluating pixels. Browser workers materialize frames.

- Immutable references prevent later edits/deletions from changing earlier frame results.
- Retain dependencies while reachable, even if protocol-visible frames are deleted. Bound DAG depth, nodes, referenced bytes, and cumulative composition/decode work; do not retain an unbounded command history.
- Decode/upload only needed frames. Presentation frame caches remain evictable/reconstructible.
- Extend graphics child codecs for frame recipes, dependency blobs, frame-loading state, gaps, loop controls, explicit frame selection, and relative timeline anchors. Add a dedicated frame child codec only when implemented.
- Native operations that depend on the current frame use pure metadata playback projection, not decoded pixels.
- Separate semantic content revisions from presentation-frame revisions. Browser repaint/ticks must not change authoritative admission or eviction ordering.
- Define event timing/clock anchors in the animation profile for new viewers/replay. No server-decoded frame stream is needed.

Until recipe evaluation and its checkpoint form are tested, animation commands remain explicitly unsupported.

## 11. Bounds and failure policy

Suggested starting limits, subject to measurement:

- Maximum dimension 4096 and decoded reservation 16 MiB per image.
- Aggregate decoded reservation 32 MiB across both screens per session.
- Aggregate encoded-image bytes 32 MiB; separate 8 MiB per-loading-transaction and aggregate loading caps.
- Bounded image/placement counts and relative depth.
- Host GPU image cache 128 MiB, separate from glyph cache.
- Two actual browser decode jobs globally; bounded queued/copied/inflated bytes.
- VT section 16 MiB, graphics section 64 MiB, total compound checkpoint 96 MiB hard caps. Lower settings must fit the negotiated profile.
- Process-wide native budget including live payloads, captures, replay references, and retained exited sessions.

Count temporary buffers, canvases/bitmaps, old/new textures, and retained captures. Native storage scales with encoded data/metadata, not raster expansion; decoded reservations cap expected client work. JS cannot perfectly constrain browser decoder allocations, so dimensions and actual-job concurrency must be conservative.

Native and WASM use identical semantic admission/eviction rules. GPU pressure only evicts presentation caches. System allocation failures must not silently produce divergent logical scenes: fail the affected session/restore operation explicitly. Corrupt checkpoints never partially replace a core. Invalid raster pixels are local display failures, not late protocol mutations or retry loops.

## 12. File plan

### New checkpoint TUs

- `common/terminal/TerminalCheckpoint.zig`
- `common/terminal/checkpoint/GraphicsSnapshot.zig`
- `common/terminal/checkpoint/graphics/EncodedImages.zig`
- `common/terminal/checkpoint/graphics/Placements.zig`
- `common/terminal/checkpoint/graphics/InProgressTransmissions.zig`

Their responsibilities and direct import graph are specified in section 3; no additional root/re-export modules are required.

### Other new files

| Path | Purpose |
| --- | --- |
| `common/terminal/graphics/GraphicsPayload.zig` | Immutable opaque payloads, digests, accounting |
| `common/terminal/graphics/ImageHeader.zig` | Shared bounded metadata inspection, not pixel decoding |
| `common/terminal/graphics/GraphicsState.zig` | Ghostty opaque adapter and resource identities |
| `common/terminal/graphics/GraphicsFrame.zig` | Visible placements and bridge records |
| `wgpuTerminal/src/browser/render/FramePresenter.js` | Shared frame consumption, glyph coordination, image layers, and presentation state; replaces duplicated backend orchestration |
| `wgpuTerminal/src/browser/render/webgpu/shaders/image.wgsl` | Browser-owned image quad shader |
| `wgpuTerminal/src/browser/images/ImageDecodePool.js` | Actual-job admission, byte limits, cancellation |
| `wgpuTerminal/src/browser/images/image-decode-worker.js` | Browser-only decompression/decode/pixel conversion |
| `wgpuTerminal/src/browser/images/TerminalImageStore.js` | Per-core payload references and decode requests |
| `wgpuTerminal/src/browser/render/ImageResources.js` | Host cache, refcounts, LRU, device epochs |
| `wgpuTerminal/src/browser/render/webgpu/GpuImages.js` | WebGPU uploads/bindings/draws |
| `wgpuTerminal/src/browser/render/webgl/WebGlImages.js` | Equivalent WebGL image path |
| `bcwebmux/web/TerminalCheckpoint.js` | Container validation and staged restore orchestration |

Animation later adds shared recipe validation and browser composition, not a native image decoder.

### Existing files to modify

| Path(s) | Change |
| --- | --- |
| `bcwebmux/build.zig`, `bcwebmux/build.zig.zon` | Pin opaque-capable Ghostty, enable graphics/profile for all instances, direct concrete-module imports/assets/tests; no native pixel-codec dependency |
| `common/terminal/Terminal.zig`, `common/terminal/main.zig` | Pull frame prepare/finish, opaque setup, graphics dirtiness/resource exports, compound restore, epochs |
| `common/terminal/Wgpu.zig` → `common/terminal/RenderFrame.zig` | Backend-neutral CPU frame v5, image draws/resources, placeholder suppression, background flags; remove GPU host imports |
| `common/terminal/FontEngine.zig` | Separate shared kb shaping/layout from STB pixel production; supply the same layout to the Canvas drawing-batch adapter |
| `common/terminal/shaders/cell.wgsl` → `wgpuTerminal/src/browser/render/webgpu/shaders/cell.wgsl` | Browser-owned split background/transparent foreground shader; one composition model |
| `common/terminal/grain.zig` and browser renderer assets | Relocate presentation grain data out of the WASM shader-initialization path; preserve visual output |
| `wgpuTerminal/src/TerminalCore.js` | Sole ABI bridge, frame lifetime, semantic controller methods, bounded source copies, reset/restore/dispose; retain synchronous logical writes |
| `wgpuTerminal/src/Terminal.js`, `wgpuTerminal/src/TerminalCoreHost.js` | Presenter ownership, attach/rollback through one frame path; remove `_wasm` and `_gpuInit`/`_gpuSubmit` coupling |
| `wgpuTerminal/src/browser/ViewportController.js`, input/selection controllers | Semantic core methods rather than direct exports; shared versioned metrics |
| `wgpuTerminal/src/TerminalOptions.js`, `wgpuTerminal/index.d.ts` | Graphics profile, limits, diagnostics options |
| `wgpuTerminal/src/browser/render/RendererSubmission.js` → `wgpuTerminal/src/FramePacket.js` | Backend-independent v5 validation/typed views, used only by the core bridge |
| `wgpuTerminal/src/browser/render/CanvasAlphaMask.js`, glyph runtime and atlas files | Presenter-owned Canvas rasterization, batched run masks, explicit glyph leases; backend atlas files only allocate/upload |
| `wgpuTerminal/src/browser/render/RenderBackend.js` | Image cache/device recreation |
| `wgpuTerminal/src/browser/render/webgpu/GpuTerminal.js`, `wgpuTerminal/src/browser/render/webgpu/GpuTerminalResources.js` | GPU operations, layered draws, device recovery; remove WASM decoding and independent scheduling |
| `wgpuTerminal/src/browser/render/webgl/WebGlTerminal.js`, `wgpuTerminal/src/browser/render/webgl/WebGlTerminalResources.js` | Equivalent GPU-only operations/shaders/context recovery |
| `wgpuTerminal/src/browser/FrameScheduler.js` | Sole core/presentation scheduler, visibility and blink/later animation deadlines |
| `bcwebmux/web/client.js` | Event-driven status, visible/enabled telemetry only; no perpetual UI polling |
| `bcwebmux/src/Session.zig` | Opaque policy, storage budgets, compound captures |
| `bcwebmux/src/session_realtime.zig`, `bcwebmux/src/SessionSocket.zig` | Immutable checkpoint/replay ownership and negotiated sizes; no decode receipts |
| `bcwebmux/src/session_manifest.zig`, `bcwebmux/src/protocol.zig`, `bcwebmux/web/protocol.js` | Codec/profile/ABI and bounds; static profile keeps existing frame/event kinds |
| `bcwebmux/web/SessionTransport.js`, `bcwebmux/web/SessionCheckpoint.js` | Logical graphics restore/cache ownership; no pixel-ready ACK/LIVE barrier |
| Native C ABI/Go bindings where bounds are exposed | Configured bounds/codec metadata only; no Go image parser/decoder |
| Terminal package scripts and READMEs | Ship worker/shaders; document CSP/browser requirements and admission semantics |

Generate compatibility provenance from the pinned Ghostty revision and feature profile. `bcwebmux/src/session_manifest.zig` currently still names `f4f9991...`; do not retain that stale identifier in the graphics ABI. Include opaque-image semantics, checkpoint version, and relevant limits; incompatible viewers must not attach as text-only ABI peers.

## 13. Tests and delivery gates

Add:

- Boundary contracts: no GPU host imports/shader payload in WASM; only the core bridge accesses exports/memory; both backends consume the same validated packet and neither schedules presentation.
- Frame lifetime tests: no-change, prepare/consumer failure, partial upload failure, rejected/stale token, memory growth between frames, reset/attach/rollback/device-loss full rebuild, and no borrowed view surviving `finish` or await.
- Scheduler tests with controlled clocks: stable idle has no recurring renderer wakeups; visible blink uses only its deadlines; hidden/disposed/failed hosts do not draw or rearm; decode completion is presentation-only; simultaneous output/input/resize/decode coalesce; inactive cores still apply logical output without rendering.
- Capacity/lifecycle tests: more visible image misses than decode slots eventually progress without terminal output; permanently over-budget scenes do not cause a retry/eviction loop; glyph repartition/core removal cannot expose stale cell references on blink or inactive-core reattachment.
- Text refactor parity on both GPU backends and both rasterizers: identical kb glyph/cluster/position results for plain text, ligatures, and combining/wide text; raster-specific antialiasing differences only where expected. Cover cursor/selection, DPR 1/2/4, font changes and shared font-data availability (including the existing Canvas-only option), capture semantics, and empty-image-list composition. Resolve any incompatible font option explicitly rather than silently bypassing kb.
- Workload measurements described in section 7.6, with diagnostics both disabled and enabled. No numerical speed/power improvement is assumed before measurement.
- `bcwebmux/test/kitty-graphics-contract.mjs`: raw/PNG/zlib, chunk boundaries, admission/query/errors, ID reuse, stale decode completion.
- `bcwebmux/test/kitty-graphics-e2e.mjs`: both backends, alpha/color, crop/layers, scrolling, Unicode/relative, DPR, graphics-only redraw, lazy readiness.
- `bcwebmux/test/kitty-graphics-resume.mjs`: tail cache retention, checkpoint fallback/new viewer, rollback, disconnect mid-decode, context loss.
- `bcwebmux/test/kitty-image-cache.test.mjs`: references/LRU, shared jobs, actual concurrency after cancellation, bounded decompression, memoized failure.
- Zig tests in each checkpoint child TU: encoded images/digests, placement anchors/parents, and incomplete transmissions; parent tests cover cross-section validation and atomic restore.
- Native/WASM differential tests for grid/cursor/images/placements/eviction/responses, and browser pixel tests for presentation.
- Native-only headless test proving PNG transmission/capture retains encoded sources with no native decoder linked/invoked.
- Valid header with invalid raster: identical logical state on both cores; browser display failure produces no late PTY response or cursor mutation.
- Existing protocol, checkpoint, renderer-submission, WASM-size, and text-golden regression coverage. Measure actual size changes before adjusting budgets.
- Animation later: immutable dependencies, deletion/replacement, bounded composition, clock projection, checkpoint timing, hidden tabs.

Delivery sequence:

1. Refactor the client on text-only behavior: sole bridge, pull-frame lifetime, shared kb shaping/layout, presenter/metrics, browser-owned assets, one scheduler, and both-backend/rasterizer parity. Remove replaced paths instead of retaining compatibility implementations internally.
2. Ghostty opaque storage/shared metadata admission and concrete TU interfaces. Prove native/WASM semantics without pixel decoders; this work can proceed independently of step 1.
3. Compound checkpoints and raw/PNG display with ordinary placements through the refactored frame pipeline. New-viewer restore is mandatory before enablement.
4. Complete static behavior, single composition model, Unicode/relative, resize/delete, reconnect/cache fencing, context recovery, budgets.
5. Browser animation recipes/timing plus checkpoint support, using the same presentation clock; enable animation only after validation.
6. Optimize measured upload/capture/cache costs, HAVE/MISSING blob transfer, tiling, and placement deltas without changing authoritative semantics.

Completion means an application can transmit images with no browser attached, the server stores them without decoding pixels, a later browser reconstructs the display, and reconnects reuse caches without trusting them as terminal state.
