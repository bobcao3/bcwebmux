# Kitty graphics: libghostty integration and delivery plan

**Status:** image support is proposed. The shared frame presenter, sole scheduler,
ABI v6, independent `kb-stb`/browser `canvas` text paths, and device recovery are
implemented. Graphics is still disabled in the native/WASM build profiles; frame
graphics fields are zero and rejected if populated. Libghostty snapshots preserve
graphics layout/placeholders, not image bytes.

**Constraint: use unmodified libghostty-vt. No fork, upstream patch prerequisite,
or dependency-cache edits.** Store encoded images in application-owned shared
Zig code; decode pixels only in browsers. The no-fork adapter below needs an
integration proof before its behavior is considered established.

Repository paths are root-relative. Upstream references below are pinned to
Ghostty `b32f20f3e8d25bb925ec545c54498e93518e7ced`, matching `bcwebmux/build.zig.zon`.
The [Kitty graphics specification][protocol] defines protocol behavior; our
browser/direct-transfer profile has explicit differences described below.

## 1. What libghostty provides, and how its clients integrate

### Replication contract

The server and every client run the same pinned libghostty terminal and shared
graphics adapter/profile. The server feeds PTY output into its terminal and
replicates it through the existing compressed PTY-diff transport; clients apply
those bytes locally on top of state snapshots. Kitty commands and image payloads
travel in that stream, not a separate image, placement or scene-update channel.
Frame records and GPU resources below are local presentation APIs, not wire state.

Only the server writes terminal-generated responses to the real PTY. Client
replicas suppress those writes, including during restore and replay; response
traces may be compared in tests without forwarding them. Browser decoding,
visibility and viewer count must not influence server responses or PTY progress.
Server-side checkpoint restoration or historical replay must likewise suppress
PTY writes; only first-time processing of live PTY output may emit a response.

Snapshots intentionally omit historical graphics bytes. This permits missing
images after resume, not malformed parsing, duplicate replies or corruption of
text/cursor state. Graphics source availability is distinct from terminal layout
and protocol state; section 5 defines the boundary and resume requirements.

### Public library boundary

[`src/lib_vt.zig`][vt-api] exports `Stream`, `TerminalStream`, `Terminal`, `apc`,
and `kitty`. [`GhosttyZig.zig`][vt-build] builds the `ghostty-vt` module from that
root. These are **public Zig APIs**, already the kind of API our native and WASM
builds import; do not assume identical entry points exist in the C ABI.

| Available library API | Integration role |
| --- | --- |
| `Stream(Handler)` and `TerminalStream.Handler.vt()` | Application action dispatch; delegate ordinary VT handling to the standard handler |
| `apc.Handler.start/feed/feedSlice/end` | Existing APC/Kitty parsing and base64-decoded payloads; no second parser in JS |
| `kitty.graphics.CommandParser`, `Command`, `Response` | Parsed controls and response encoding |
| `ImageStorage.addPendingImage()` | Dimensions and expected decoded-byte reservation without resident pixels; returns ID/generation token |
| `Terminal.kittyGraphics()` / `kitty.graphics.execute()` | Existing command execution, including display/delete |
| `ImageStorage` placement, parent and geometry helpers; `graphics.unicode.placementIterator()` | Placement semantics, tracked pins and Unicode fragments |

The relevant definitions are in [stream][stream], [standard handler][handler],
[APC][apc], [graphics exports][graphics], [image storage][storage], and
[Unicode placement code][unicode]. Kitty APIs/storage require `+kitty-graphics`
and a nonzero storage limit; both native and WASM must use the same profile.

### Reference clients: copy the boundary, not frontend dependencies

- **Standalone C embedder:** [`example/c-vt-kitty-graphics`][c-example] installs a
  synchronous PNG callback with `ghostty_sys_set`, creates/resizes a terminal,
  sets its image-storage limit and PTY-response callback, feeds bytes through
  `ghostty_terminal_vt_write`, then reads generations, images and placements.
  Its decoder is a hardcoded demonstration, not a production decoder. This is
  the clearest example of an actual libghostty-vt consumer, but its eager pixel
  decoding is **not** our server design.
- **Ghostty's desktop application:** [`src/termio/stream_handler.zig`][app-handler]
  uses `terminal.Stream(StreamHandler)`, feeds the shared APC parser, executes
  parsed Kitty commands via `Terminal.kittyGraphics()`, and sends replies to the
  PTY. It uses the same terminal core internally, not the public C ABI.
  [`src/renderer/image.zig`][app-images] and [`generic.zig`][app-renderer] show the
  separate renderer consuming terminal image state and managing presentation.
  These are application examples, **not library exports to import** into WASM;
  their threads, mailboxes and GPU/platform machinery remain outside our design.

### What is not provided

Ghostty's [default loader][image] synchronously inflates compressed bodies and
converts PNG to decoded pixels. [`sys.decode_png`][sys] is a synchronous decoder
callback returning pixels, not an async/opaque-payload hook; it defaults to null
for library builds. Enabling Kitty also wires in Wuffs for pixel operations.
“No native pixel decoding” does not mean “no image-related dependency compiled.”

`Image.data.pending` means decoded bytes are absent, **not** built-in encoded
storage or a completed opaque-image mode. We must prove that using these metadata
records with our own payload store preserves the required semantics.

## 2. Shared application adapter: first implementation gate

Implement one concrete adapter used by native and WASM, using only existing
library APIs. Keep Ghostty authoritative for terminal state and placements;
the adapter owns encoded payloads, admission policy and transmission bookkeeping.

Use identical logical controls, limits and ordered session events on native and
WASM. Viewer-local sizes must not resize the replicated terminal independently;
use the existing authoritative session resize path. Shared admission and terminal
mutations must not depend on browser decode results, GPU pressure or wall time.
The payload sidecar is not an independent placement database or replication layer.

Proposed flow:

1. Wrap `Stream` action dispatch. Reuse Ghostty's APC parser; intercept Kitty
   transmit/query actions before the default eager loader. Delegate ordinary VT
   actions to the standard handler and preserve non-Kitty APC behavior/effects.
2. Assemble bounded direct-transfer chunks. Validate controls, base64 results,
   dimensions and resource reservations; preserve first-command parameters,
   quiet/response IDs, deferred display and final-chunk cursor semantics.
3. Retain immutable encoded bytes. Candidate representation: register image
   dimensions/decoded reservation with `addPendingImage()` and associate its
   ID/generation with the application payload. Logical admission is complete
   even while Ghostty's pixel field remains pending; browser decode must not
   gate admission or require decoded bytes copied back into native/WASM storage.
4. Reuse display/delete execution and geometry helpers where compatible. The
   adapter supplies transmit/query outcomes and rejects unsupported actions;
   it must preserve ID allocation, replacement, quiet and error behavior rather
   than assuming the storage insertion API performs all transmission semantics.
5. Reconcile payload references after replacement, eviction, deletion, scrolling,
   screen switching and reset. Ghostty storage is the authority for residency;
   a sidecar entry or cached texture cannot keep a deleted placement alive.

**Prove this boundary before building the image UI:** a headless transmit/query,
placement, replacement/eviction and deletion must work without invoking pixel
decoding. Check standard-handler semantic failures and APC cancellation. Snapshot
integration must detect and prove a safe boundary that does not straddle a
graphics sequence or require capturing/replaying partial graphics parser or
upload state. Ordinary non-graphics continuation remains outside this scope.
If an API cannot support a requirement, record the concrete limitation and revise
our adapter/profile; do not silently patch Ghostty or store fake decoded pixels.

### Supported profile and admission

Initially support direct RGB/RGBA, PNG and zlib; chunked transmission, query,
transmit/display/delete; ordinary, Unicode/virtual and relative placements on
both screens and in scrollback. Reject file, temporary-file, shared-memory and
URL sources. Animation is unsupported; reject animation actions.

For PNG, inspect signature/IHDR, CRC, legal fields and dimensions with checked
arithmetic. IHDR overrides command dimensions. Compressed PNG permits a bounded
zlib header probe only far enough to inspect IHDR; no raster inflation/filtering.
Validate the compressed-PNG `S` declaration against the profile's bounds. Reject
APNG; only static PNG images are supported. Uncompressed raw byte counts must
match exactly.

Admission validates metadata, not the entire compressed raster. Success/query
responses mean **logically accepted**, not “browser decode succeeded.” A later
invalid raster is a memoized local display failure with a bounded diagnostic;
never emit a late PTY reply or change cursor/placement state. Session-profile
negotiation does not negotiate this distinction with arbitrary PTY applications;
document it as a compatibility difference, not full protocol equivalence.

## 3. Ownership, identities and bounds

| Owner | Retained state |
| --- | --- |
| Ghostty terminal | Image metadata/reservations, IDs, placement maps, pins and terminal semantics |
| Shared application graphics code | Immutable encoded blobs, digests, incomplete transmissions, admission accounting |
| Checkpoint capture | Immutable graphics layout/placeholders at one safe boundary |
| Browser decoder/cache | Owned source copies, bounded jobs, decoded images and evictable GPU textures |

Local identity is `(coreEpoch, screen, imageId, imageGeneration)`. Cross-core cache
identity is SHA-256 over a versioned descriptor containing format, compression,
dimensions and encoded bytes. Add decode-policy/device epochs to texture keys.
Use BigInt or paired u32 words for u64 identities, never lossy JS Numbers.
Reset/restore/disposal invalidates core ownership; device loss invalidates GPU
ownership. Shared jobs/resources hold separate references for each consumer.

Bound dimensions, decoded reservation per image and across both screens, encoded
bytes, incomplete uploads, image/placement counts, and relative depth (at least
eight). Track process-wide retained/exited sessions and replay references too.
With the same starting state and input history, native and WASM logical admission
and eviction must agree; GPU pressure evicts only presentation caches. After
snapshot resume, absent historical sources must not be mistaken for terminal
deletion or newly available logical capacity. Prove which accounting/identity
state the existing snapshot preserves before choosing the adapter representation;
do not assume that it serializes sidecar counters or encoded-byte reservations.
Any unavailable bookkeeping must have a shared, safe reconstruction rule, not
viewer-dependent admission that changes terminal semantics. If the existing APIs
cannot provide this, narrow the supported profile and document the limitation
rather than adding graphics payload snapshots or another state channel.
Local allocation failure must stop the affected replica explicitly (and permit
recovery), not silently skip bytes or produce a different protocol response.
Presentation allocation failure may leave an image undrawn without logical mutation.

Starting budgets **to validate**, not protocol guarantees: dimension 4096;
16 MiB decoded/image, 32 MiB aggregate decoded reservation, 32 MiB encoded,
8 MiB per loading transaction plus an aggregate loading cap; 128 MiB host GPU
image cache separate from glyphs; two actual browser decode jobs. A 3840×2160
RGBA image exceeds the proposed per-image cap, so choose limits against intended
workloads. Count temporary buffers/bitmaps, concurrent old/new resources and
captures, not just settled textures. Bound every queue and retained draw list.

## 4. One browser frame and decode pipeline

Retain the implemented ownership split: `TerminalCore`/`FramePacket` alone access
WASM, `FramePresenter` owns committed presentation, `FrameScheduler` alone grants
presentation opportunities, and backends perform GPU operations. Keep both text
paths and their shared alpha atlas unchanged; image textures are separate.

Extend/version the current frame ABI with bounded image resources and draws:
resource handle/generation, layer/z/stable order, destination/source/clip rectangles.
Validate counts, ranges, identities, finite floats, enums and source bounds before
consumption. Graphics changes, viewport movement and metric changes must bypass
the current text/cursor-only no-change decision. Copy retained draw records when
their revision changes; begin with complete dirty lists, not placement deltas.

`consumeFrame(consumer)` remains synchronous: prepare, validate/consume, finish in
`finally`. No mutation, source lookup, memory growth or await while borrowed views
are live. Rejected/partial uploads suspend presentation until a full replacement.
After releasing the frame, `copyImageSource(handle, generation)` returns owned
bytes/metadata or stale/missing, rechecking core/resource identity.

Decode on a visible cache miss:

1. Reserve actual-job/queue capacity and source/decoded bytes **before copying**.
   Defer other misses as bounded references to the current draw list.
2. In a worker, consume `DecompressionStream("deflate")` incrementally with output
   caps; never build an unbounded decompressed Blob first. Expand raw pixels or
   use `createImageBitmap`/feature-tested browser decoding for PNG with explicit
   orientation, alpha and color policy. Verify decoded dimensions.
3. Completion marks presentation dirty; only a scheduler opportunity installs
   uploads still owned by the current core/resource/device. It never reparses VT,
   emits PTY replies, or uploads directly from a promise callback.
4. Close/discard stale bitmaps/frames and release buffers. Cancellation does not
   release an actual-job slot until that browser job finishes. Memoize failed
   digests/policies. Completion, capacity release and visibility return reconsider
   misses without requiring terminal output or spinning on over-budget scenes.

A snapshot placeholder with no encoded source is not a pending decode job or a
transport error. Leave its image undrawn and memoize source absence for that
resource generation; do not poll, request historical image bytes, replay PTY
output for pixels or block text presentation. A later complete transmission may
provide a new source. Reuse cached content only with a proven content identity;
image ID or placement identity alone is insufficient after restore or ID reuse.

Logical writes and ACKs remain synchronous and independent of pixels. Hidden or
inactive cores may parse/ACK but start no visibility-only decode/render work.
Device recovery rebuilds textures from retained encoded sources, not PTY replay.
Tail reconnect retains valid caches/jobs. Snapshot resume applies authoritative
captured layout/placeholders at commit and then the ordered tail; missing
historical image bytes are acceptable. Local presentation-cache reuse is optional
and does not provide snapshot image delivery. Rollback releases only shadow
references. No texture-ready ACK or LIVE barrier is introduced.

### Composition on WebGPU and WebGL2

Resolve geometry with canonical cell sizes, then map into each viewer's physical
grid. Reuse Ghostty crop, parent-chain and Unicode helpers; clip geometry and UVs.
Suppress placeholder glyph rasterization without changing stored text/selection.
Split the current opaque combined-cell shader into this ordered composition:

1. Default terminal background/grain.
2. Images with `z < -1073741824`.
3. Effective cell backgrounds, including inverse/selection; distinguish default
   from explicit backgrounds so default cells do not erase underlying images.
4. Images with `-1073741824 <= z < 0` (virtual fragments use `z = -1`).
5. Transparent glyphs/decorations/cursor, matching Ghostty selection/cursor policy.
6. Images with `z >= 0`, then existing UI overlays under their own policy.

Use the same model for text-only frames, skipping empty image ranges. Sort by z
and upstream image-ID tie rules with deterministic residual ties; batching must
not reorder overlaps. Start with one texture per resident payload, shared across
placements. Test raw and PNG alpha/sRGB behavior on both backends. Unsupported
device dimensions are a bounded local presentation failure, not logical deletion.

## 5. Snapshot boundaries and resume

Libghostty snapshots retain graphics layout and placeholders, but not graphics
bytes. Existing compressed PTY diffs remain the live replication path. Snapshot
boundaries must not straddle graphics sequences: select and prove a safe boundary
before capture, rather than capturing or replaying partial graphics parser or
upload state. A read, compressed transport frame or individual APC terminator is
not automatically a safe boundary. Require no partial graphics escape/APC and no
unfinished chunked transmission (including gaps after `m=1`); check all active
transmissions. Completion or protocol cancellation must be processed before the
boundary is eligible. Preserve the existing ordinary VT continuation behavior.

Snapshot cadence is approximate, not an exact event or interval requirement.
Defer capture while waiting for a safe boundary, continuing cheap ordered diff
delivery. An older retained safe snapshot plus its complete ordered tail is also
valid. Retain replay coverage for any offered snapshot; never drop required tail
bytes merely to meet a snapshot timer. Bound retention and capture work. The
backpressure/admission policy for long-running or unfinished graphics sequences
must be defined before shipping; it must not force an unsafe snapshot or silently
truncate the sequence. No fixed snapshot interval is required.

Capture VT and graphics layout/placeholders atomically at a safe boundary under
the session mutex. Encode and transmit from immutable captures without borrowing
mutable state after unlocking. Hand off the ordered snapshot tail so diffs after
the captured boundary are delivered exactly once and in order. Resume restores
the snapshot and applies that tail; it need not be visually equivalent to
uninterrupted PTY-diff replay, and missing historical image content is acceptable.
Do not synthesize display commands onto restored text or partially replace a core.
Subsequent complete graphics transmissions populate newly available content.

Later display, query, delete and replacement commands can refer to images whose
bytes were omitted. Prove these paths remain safe with layout/placeholders alone:
do not fabricate pixels, reissue historical replies or let a missing source change
text/cursor effects. The server remains the sole PTY-response authority. Full
graphics-byte/visual equivalence with uninterrupted replay is not an acceptance
criterion; safe terminal continuation and source-absent rendering are.

Keep CHECKPOINT_BEGIN/CHUNK/END, CRC/digest, credit framing and applicable
compatibility negotiation. Preserve existing negotiated VT/transport limits
without introducing graphics-byte snapshot budgets or compound payload sections.
Avoid repeated full copies and account for old/shadow cores and concurrent
captures. Local cache hits may avoid decode/upload, but cache reuse is optional
and is not required for correct resume.

## 6. Concrete module plan

All paths below are proposed unless noted. Use direct imports, no directory-level
re-export layer, duplicated VT codec, second scene database or generic resource bus.

| Path | Responsibility |
| --- | --- |
| `common/terminal/graphics/GraphicsState.zig` | Shared stream/admission adapter and Ghostty-to-payload identity/reference reconciliation |
| `common/terminal/graphics/GraphicsPayload.zig` | Immutable encoded blobs, digests and reservations |
| `common/terminal/graphics/ImageHeader.zig` | Bounded metadata inspection only |
| `common/terminal/graphics/GraphicsFrame.zig` | Visible geometry using Ghostty helpers |
| `common/terminal/TerminalCheckpoint.zig` | Existing checkpoint integration for atomic safe-boundary capture and ordered snapshot-tail handoff |
| `wgpuTerminal/src/browser/images/{ImageDecodePool,TerminalImageStore}.js`, `image-decode-worker.js` in that directory | Bounded browser jobs and per-core source references |
| `wgpuTerminal/src/browser/render/ImageResources.js` | Shared cache/references and device epochs |
| `wgpuTerminal/src/browser/render/{webgpu/GpuImages,webgl/WebGlImages}.js` | Backend image upload/draw operations and associated shaders |

Extend existing `Terminal.zig`, `RenderFrame.zig`, `TerminalCore.js`, `FramePacket.js`,
`FramePresenter.js` and both backends; do not recreate their ownership refactor.
Wire shared native/WASM modules and worker/shader assets in `bcwebmux/build.zig`.
Extend `Session.zig`, replay capture ownership, `SessionCheckpoint.js` and transport
profile/bounds together for safe-boundary capture and ordered tail handoff. Keep
browser restore orchestration at the existing checkpoint boundary. Document
worker/CSP/browser requirements in component guides.

## 7. Delivery and acceptance

Delivery gates:

1. **No-fork adapter proof:** public Zig APIs compile/work on native and WASM;
   metadata-only admission, pending-image placement/eviction and safe graphics-boundary
   detection hold. Prove no native PNG/raster decode is invoked; separately
   report linked dependencies/size rather than claiming Wuffs is absent.
2. **First usable slice:** safe-boundary snapshot and ordered tail handoff plus
   ordinary raw/PNG display on both GPU backends. New-viewer restore must be safe;
   historical image bytes may be absent. Subsequent complete graphics transmissions
   must work.
   Request captures at every byte boundary of graphics escape/APC sequences and
   between upload chunks; verify capture defers to a safe boundary and the tail
   has no gaps or duplicate application. Test cancellation and multiple uploads.
   Resume with no image cache; missing sources must not cause retries or stalls.
3. **Complete static profile:** differential native/WASM state/responses and GPU
   tests for chunk/query/quiet behavior, `i` versus `I`, replacement, all deletion
   selectors, scrolling/margins/reset/alternate screens, crop/layers, Unicode
   inheritance and relative-parent lifetimes/cycles/depth. Test `S`, final-chunk
   cursor positioning, delete-aborts-upload, and query-before-device-attributes.
   Compare uninterrupted native and multiple WASM replicas given the same starting
   state and events, including hidden clients and different decode completion order.
   Separately test snapshot resume with missing historical bytes, then references
   to old image IDs, replacement, capacity pressure and new transmissions. Compare
   preserved terminal semantics, not omitted payload bytes or historical pixels.
   Verify each required PTY reply is emitted only once by the server regardless of
   viewer count, reconnects or replay; honor each command's quiet/error policy.
4. **Lifecycle/security:** tail/checkpoint/rollback, mid-decode disconnect, ID reuse,
   context loss, stale completion, actual concurrency after cancellation, bounded
   decompression, invalid-header/raster distinction, corrupted snapshots and
   overloaded queues. Deferred visible misses progress without new output;
   permanently over-budget scenes do not thrash or retry each frame.
5. **Measured optimization:** retain text goldens for both text paths/backends,
   DPR 1/2/4, cursor/selection and capture semantics. Measure preparation/upload
   bytes, p50/p95 frame times and idle/hidden wakeups before upload/capture changes,
   local draw-list deltas or tiling; do not introduce an image-transfer side channel
   or infer power from FPS.

Tests belong alongside the shared graphics and checkpoint integration code and in `bcwebmux/test/kitty-graphics-{contract,e2e,resume}.mjs`
and `kitty-image-cache.test.mjs`. Existing renderer, protocol, checkpoint and WASM-size suites remain gates.

[protocol]: https://sw.kovidgoyal.net/kitty/graphics-protocol/
[vt-api]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/lib_vt.zig
[vt-build]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/build/GhosttyZig.zig
[stream]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/stream.zig
[handler]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/stream_terminal.zig
[apc]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/apc.zig
[graphics]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/kitty/graphics.zig
[storage]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/kitty/graphics_storage.zig
[unicode]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/kitty/graphics_unicode.zig
[image]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/kitty/graphics_image.zig
[sys]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/terminal/sys.zig
[c-example]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/example/c-vt-kitty-graphics/src/main.c
[app-handler]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/termio/stream_handler.zig
[app-images]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/renderer/image.zig
[app-renderer]: https://github.com/ghostty-org/ghostty/blob/b32f20f3e8d25bb925ec545c54498e93518e7ced/src/renderer/generic.zig
