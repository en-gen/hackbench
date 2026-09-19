# Per-pass canvases: spike findings

Throwaway spike. The deliverable is these numbers and a recommendation; the
harness is gitignored at `tools/spike/` and is not part of the product.

## Question

The map editor renders a whole level into ONE software framebuffer.
`CanvasRenderTarget` creates a single `ImageData` and every `blit8x8` and
`fillRect` writes bytes into its `Uint8ClampedArray`; the canvas is touched
once at the end. `SmwMap.render` fills it in hardware order.

Should each PASS instead get its own buffer and canvas, stacked with CSS so
the browser composites them? A pass is a `(layer, priority)` pair, not a
layer: Layer 1 appears in two of them.

## Recommendation

**Build it for the layer toggle, not for speed, and only with a per-level
pass list.**

Base render gets SLOWER, 0.92x to 1.81x. Memory multiplies by the live-pass
count. The toggle drops from a full rebuild to a CSS `display` change, which
is a per-interaction cost the user feels. Memory is what constrains the
design: a fixed 5 or 6 buffer list is not affordable, a data-driven one is.

## Evidence scope

Cart: `Super Mario World (USA).vanilla.sfc`, 524288 bytes, no copier header.
Browser: Chromium 152 in a hidden pane. Code: `origin/develop` at `a160b10`,
unmodified. Timings are medians of 15 or 21 warm iterations, first dropped,
alternating single and per-pass every iteration so drift and GC hit both
arms. Machine noise between separate runs is +/-30%; only within-run A/B
deltas are trustworthy, and totals below carry their interquartile range
where it was recorded.

Not measured: real GPU compositing of the CSS stack, GPU-side memory of the
canvas backing stores, and behaviour inside a real VS Code webview. The pane
runs hidden and throttles rAF to about 8 fps, and `performance.memory` sees
only the JS heap.

## 1. Base render time

Main-thread JS, ms, median, per-pass allocating only live passes.

| level | size px | live passes | single | per-pass | ratio |
|---|---|---|---|---|---|
| `$10A` widest | 8192x432 | 4 | 117.7 | 137.2 | 1.17 |
| `$125` | 8192x432 | 4 | 82.5 | 105.6 | 1.28 |
| `$0F7` tallest | 512x6656 | 3 | 88.0 | 94.8 | 1.08 |
| `$11E` | 5120x432 | 4 | 70.1 | 84.9 | 1.21 |
| `$1EC` | 4096x432 | 5 | 29.4 | 53.2 | 1.81 |
| `$111` | 3840x432 | 5 | 26.7 | 44.7 | 1.67 |
| `$001` | 5120x432 | 4 | 52.5 | 66.1 | 1.26 |
| `$105` | 5120x432 | 4 | 58.7 | 91.0 | 1.55 |
| `$1D2` | 1280x432 | 4 | 20.8 | 23.0 | 1.11 |
| `$024` | 1024x432 | 3 | 23.5 | 21.7 | 0.92 |
| `$1F8` | 256x432 | 3 | 4.0 | 4.3 | 1.07 |

**Blit is unchanged.** Same total pixels, same cost. A first pass measured a
12 to 38 percent blit penalty; that was an artifact of running three
configurations per iteration. A clean two-way alternating A/B on `$10A`
gives 104.5 vs 104.8 ms single-first and 103.1 vs 103.6 ms per-pass-first.
Every regression is fixed per-buffer cost, not drawing.

Allocating all 6 passes instead of the live ones costs a further 10 to 70 ms,
worst on `$0F7` at 94.8 ms live against 156.9 ms fixed-6. The skip-empty
mitigation is real and large.

## 2. Peak memory

Analytic, exact: `buffers * W * H * 4` for the `ImageData`, plus the same
again for each canvas element's backing store.

| level | single | per-pass live | per-pass fixed 6 |
|---|---|---|---|
| `$10A` 8192x432 | 13.5 / 27 MB | **54 / 108 MB** (4) | 81 / 162 MB |
| `$11E` 5120x432 | 8.4 / 16.9 MB | 33.8 / 67.5 MB (4) | 50.6 / 101.3 MB |
| `$0F7` 512x6656 | 13.0 / 26.0 MB | 39.0 / 78.0 MB (3) | 78 / 156 MB |

`performance.memory.usedJSHeapSize` delta across the render corroborates the
`ImageData` figure: 6.6 MB single vs 40.7 MB at 4 buffers on `$10A`. The heap
delta is GC-noisy and is not a peak-memory measurement. The canvas backing
store is in renderer accounting and was NOT observed; that column is an
estimate from 4 bytes per pixel.

`src/extension.ts` runs `retainContextWhenHidden: false`, so only visible
editors hold buffers. That is what makes 54 MB survivable.

## 3. Pass occupancy

Across all 512 vanilla level ids, all of which build. A pass counts as live
if it issues at least one draw.

Live-pass histogram: **2 passes on 294 levels, 3 on 89, 4 on 118, 5 on 11.
Never 6.** Mean 2.70.

**CORRECTION, from the OBJ-priority work on `feature/oam-priority`.** That
histogram treats Layer 3 as one blob and sprites as one pass. Under the
real mode-1 table BG3.0 and BG3.1 are separate passes at separate stack
positions, and sprites split up to three ways. Re-measured over all 512
ids: 2 on 294, 3 on 83, 4 on 112, **5 on 19, 6 on 3, and 7 on one
(`$1E2`)**. The ceiling is 7, not 5. The conclusion that the pass list
must be per level is unaffected and gets stronger; the memory figures
below, which assume at most 4 live passes on the levels measured, are a
floor rather than a worst case.

Levels where each pass draws anything: `l2` 504, `l1np` 503, `sprites` 220,
`l1p` **129 (25%)**, `l3back` 18, `l3front` 8.

Coverage is uneven, which is the fixed-cost problem: the sprites pass covers
0.17% to 1.11% of the buffer and the Layer 1 priority pass 0.06% to 16.6%.
Both would pay a full-size clear and a full-size upload.

**The pass list must be data-driven per level, not a fixed array.** The
liveness probe is cheap: running each pass against a no-op counting target
for all 512 levels took 7.0 s total, about 14 ms per level including the map
build, and the build dominates that.

## 4. Layer toggle (sprites off)

Medians of 11 warm iterations.

| level | single, rebuild | per-pass, `display:none` |
|---|---|---|
| `$10A` | 79.3 ms | 0.2 ms |
| `$125` | 44.9 ms | 0.2 ms |
| `$11E` | 44.1 ms | 0.2 ms |
| `$1EC` | 21.5 ms | 0.2 ms |
| `$024` | 9.4 ms | 0.1 ms |
| `$1F8` | 3.6 ms | 0.1 ms |

The single-buffer arm is clear plus re-render every pass except sprites plus
upload, reusing the canvas, which is what `renderModelOverlay` does today via
the reactive effect on `store.layerToggles`. The real cost today is HIGHER
than the table: that effect also re-runs the canvas-2D overlay draws, a
full-canvas `drawImage`, and the viewport blit. So 79.3 ms is a floor.

Compositing, which per-pass adds: CPU-path `drawImage` of N stacked 8192x432
layers measures 1.06 ms at 1 layer, 2.12 ms at 4, 2.84 ms at 6, so about
0.35 ms per extra layer. An order of magnitude less than the per-buffer clear
it replaces. The real CSS stack composites on the GPU and is cheaper still.

## 5. The clear hypothesis, tested and refuted in part

`CanvasRenderTarget.clear()` loops every pixel in JS setting four bytes. The
hypothesis was that fixing it would flip the verdict, making per-pass cheaper
than single on base render.

**It does not.** The fix helps both arms, so the gap narrows but does not
close. Per-pass stays 1.4x to 1.8x.

Microbenchmark at 5120x432, 8847360 bytes, 20 iterations each:

| strategy | ms |
|---|---|
| per-pixel loop, as shipped | 3.09 |
| `Uint8ClampedArray.fill(0)` | 0.34 |
| `Uint32Array` view `.fill(packed)` | 0.335 |
| fresh `ImageData`, already zeroed | 0.165 |

End to end on `$11E`, two interleaved runs, patched vs shipped:

| | shipped clear | packed-fill clear |
|---|---|---|
| per-pass clear | 26.6 / 22.1 ms | 8.4 / 6.4 ms |
| single clear | 6.7 / 5.7 ms | 3.2 / 2.1 ms |

The clear colours actually used are `[0,0,0,0]` and `[222,255,222,255]`, so a
zero-only fast path is not enough; packing RGBA into a u32 and filling a
32-bit view handles both. Byte-for-byte identical output verified for the
non-zero colour.

**This is a free win for the single-buffer renderer shipping today**, about
3.5 ms off every map build, independent of any per-pass decision.

## 6. The largest per-buffer cost is unmeasured

Summing the harness's own buckets against its reported total, on `$11E` with
the fast clear:

| | alloc+clear+blit+upload | total | unaccounted |
|---|---|---|---|
| single, 1 buffer | 41.1 ms | 49.1 ms | 8.0 ms |
| per-pass, 4 buffers | 52.7 ms | 86.7 ms | **34.0 ms** |

About 8.5 ms per buffer lands outside every named bucket. Candidates are
canvas element creation, `getContext`, `createImageData`, and the final
composite. This is the single largest per-buffer term and no one has
attributed it. If per-pass is built, this is where the remaining cost lives,
not in clear.

## 7. Priority census, verified against emulator capture

Counted over all 512 level ids. A cell counts as priority if any of its four
Map16 subtiles carries the BG priority bit.

- **Layer 1 priority cells: 7,892.**
- **Layer 2 priority cells: 0**, out of 1,058,766 Layer 2 cells.
- Cells mixing priority and non-priority subtiles inside one 16x16: **666**.
  These are the cells that genuinely force Layer 1 into two passes at the
  same grid position.

Ranked by Layer 1 priority cells: `$10A` 923, `$1EC` 630, `$11E` 462, `$126`
441, `$1D2` 411. By share of occupied cells, `$11E` at 462/2762 (16.7%) sits
behind `$1D2` (46.2%) and `$1EC` (31.9%).

**Grid cross-check.** Our expander's Layer 1 grid matches the Mesen fixture
`map16.txt` cell for cell with **zero diffs** on `$11E` (8,640 cells), `$10A`
(13,824) and `$126` (8,640), and the priority counts resolved on the captured
grid are identical to those on ours. So 7,892 rests on a grid verified
against the game, not only on our expander. Fixtures were read only.

## 8. Corrections to the framing this spike was given

- **There is no Layer 2 priority pass and no Layer 3 priority pass in the
  code today.** `L2Layer.ts:58-59`, `:197-198` and `:228-229` call
  `tile.render(..., 'nonPriority')` and `tile.render(..., 'priority')` back
  to back into the same target, and `L3Layer.render` takes no phase at all.
  Only Layer 1 has a real split. The pass set is at most `l3back, l2, l1np,
  sprites, l1p, l3front`, and the two Layer 3 passes are mutually exclusive
  per level, so the ceiling is 5. That matches the measured maximum.
- **Consequently a romhack that sets the Layer 2 priority bit renders it
  BELOW sprites today**, which is wrong regardless of this spike. Splitting
  Layer 2 into two passes is a behaviour change, not just a buffer change.
- The named risk, that N allocations, clears and uploads might make the split
  a net loss, is real but is not the main cost. On the widest level it is
  +19.5 ms against a 117.7 ms render, and it buys a 79.3 ms to 0.2 ms toggle.
  Memory is what constrains the design.
- Skip-empty is worth more than assumed for Layer 2 priority specifically
  (there is no such pass to skip) and its real value comes from `l1p`, absent
  on 75% of levels, `sprites`, absent on 57%, and `l3`, absent on 95%.

## Reproducing

Harness at `tools/spike/`, gitignored, 393 lines. `tools/*` is in
`.gitignore`, so it never enters a commit.

```
npm ci
SPIKE_DATA_DIR=<dir holding the rom> npx vite --config tools/spike/vite.spike.config.ts
```

Open `http://localhost:5199/?rom=/@fs/<abs path to rom>` and call
`window.spike.{bench,occupancy,toggle,memory,census,passLive,verifyGrid}`
from the console. The harness does not edit `src/`: it reimplements
`SmwMap.render`'s pass order over the public `l1`/`l1Tiles`/`l2`/`l3`/
`sprites` surface.
