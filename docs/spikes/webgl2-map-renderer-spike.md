# WebGL2 map renderer: spike findings

> **Bottom line**
>
> - Pixel parity holds: GL `readPixels` equals the CPU `CanvasRenderTarget` byte for byte on all 3072 corpus levels (6 ROMs x 512 ids), 0 failed, 0 unbuildable. `[EST]`
> - Full-map repaint is NOT much faster: median 1.12x over 512 vanilla levels (1.00x on the 311 small ones, 1.48x on the 71 slow ones), because the model walk (`SmwMap.render`) is the floor. `[EST]`
> - Palette-only repaint is the win: 3.7x median, 10x on slow levels, up to 54x, 1.1 ms median, with no model walk at all. `[EST]`
> - The wire shrinks 29x to 173x (51.9 MB to 0.82 MB on `$10A`), and JS heap for a render falls 14.3 MB to 4.3 MB, but GPU memory is 31.6 MB on `$10A` against 14.2 MB. `[EST]`
> - Chromium keeps 16 live WebGL contexts per page; the 17th creation evicts the oldest and nothing restores it. One context per map tab breaks at 17 tabs. `[EST]`
> - Recommendation: CONDITIONAL GO, for palette editing, palette animation and payload size, not for full-repaint speed. Conditions are in the last section. `[INF]`

## Provenance

| Source | Identifier | As of | Retrieved |
|---|---|---|---|
| Code under test | `origin/develop` at `01ab06f8`, unmodified; harness in an uncommitted folder | 2026-10-10 | 2026-10-10 |
| ROMs | the six in `test/suite/support/corpus.ts` `CORPUS` (vanilla, Lunar Magic resave, four hacks), 512 level ids each | 2026-10-10 | 2026-10-10 |
| Browser | Playwright Chromium (reports 153.0.0.0), headed, visible window, `visibilityState` "visible" on every run | 2026-10-10 | 2026-10-10 |
| GPU | NVIDIA GeForce RTX 3050 via ANGLE Direct3D11, driver 32.0.16.1692; Ryzen 9 5950X, 64 GB, Windows 11 | 2026-10-10 | 2026-10-10 |
| Shipped wire | `MapScreenResult.planes` in `theia/extension/src/common/project-protocol.ts`, produced by `mapScreen` in `theia/extension/src/node/map-screen.ts` | `01ab06f8` | 2026-10-10 |
| Prior spike | `docs/spikes/per-pass-canvas-spike.md` (rAF throttling in a hidden pane; harness shape) | `01ab06f8` | 2026-10-10 |

## Question

Can a WebGL2 `RenderTarget` draw the map editor's model graph with the same pixels as today's CPU renderer, and is it worth it?
`SmwMap.render(target)` calls `blit8x8` once per 8x8 subtile and `fillRect` rarely; the CPU target (`src/webview/mapEditor/CanvasRenderTarget.ts`) writes bytes into one `ImageData`.
The spike swaps only the target.

## Scope and what was not measured

- Sprites are off (`editorStore.setLayerToggle('sprites', false)`), so no OAM priority, sprite pixel arrays or `renderAboveL1`. Colour math (`ColorMath.ts`) and Mode 7 are not touched. `[EST]`
- The "CPU" arm is the model path through `CanvasRenderTarget`. The shipped Theia widget does not use it: it draws per-screen planes in `map-screen.ts` with `renderMap16Tile`. So the speed ratios compare two targets on the same model walk, not GL against the shipping widget. `[EST]`
- Not measured: Electron's own Chromium (Theia pins Electron 42.10.0 in `theia/electron-app/package.json`; the Chromium inside it was not read), a second GPU or integrated GPU, a non-Windows driver, compositor/swapchain memory. `[OPEN]` Resolve by running the harness inside the Electron app.
- `performance.now()` values are multiples of 0.1 ms, so sub-millisecond cells are coarse. `[EST]`
- Display ran at about 55 Hz (median rAF interval 18.0 ms), not 60. `[EST]`

## Design as built

- One `R8UI` atlas texture holds every tile: 128 tiles per atlas row, 1024 x 2048 texels (capacity 32768 tiles, 2 MiB). A tile is keyed by the identity of the `Uint8Array` that `Char.getPixels()` returns, in first-seen order. `$10A` uses 156 tiles (9984 bytes). `[EST]`
- Palette rows live in a 16 x 256 `RGBA8` texture. `blit8x8` gets `RgbaColor[]`, not an index, and `Palette.row()` hands back a reused scratch array, so identity is useless. The harness hashes the 16 RGB entries (alpha ignored, the CPU writes 255), compares on a hit, and assigns the next texture row on a miss. Row id is therefore "order of first appearance of a distinct 16-colour content within one map". Two palette rows with identical colours share a texture row. Rows shorter than 16 are padded with black; the CPU would abort a tile that reads past a short row, and parity held on all 3072 maps, so none did (81,968 short-row blits on vanilla). `[EST]`
- Each `blit8x8` appends one instance (x, y, tile, row | flipX | flipY | alpha as 9 bits) to an `Int32Array`; `commit()` uploads it and the dirty atlas rows; one `drawArraysInstanced(TRIANGLES, 0, 6, n)` draws a segment. Fragment shader: `texelFetch` the atlas (flip applied to the local coordinate), discard index 0, `texelFetch` the palette. No filtering anywhere. `[EST]`
- Draw order is instance order inside a draw call, which is what makes overdraw match the CPU. `fillRect` ends a segment and becomes a scissored clear. The corpus never calls it with sprites off (0 calls). `[EST]`
- Hidden-tile blends (alpha < 1, the blue P-switch ghost) cannot use fixed-function blending: it rounds ties up, the CPU's `Uint8ClampedArray` rounds ties to even, and the first sweep was off by 1 on 244 px of `$10A`. Alpha instances form their own segment; the harness copies the framebuffer to a texture and the shader blends from the copy with ties to even. Alpha values are quantised to 1/256 (0.5 is exact; 0 inexact values across all 3072 maps). Two overlapping alpha tiles inside one segment would read the stale copy; none occurred. `[EST]`

## 1. Pixel parity

Full sweep, `readPixels` of the whole map against the CPU `ImageData` buffer, every id 0..511 per ROM, clear colour = the map's back-area colour.

| ROM | built | passed | failed | unbuildable | alpha blits |
|---|---|---|---|---|---|
| vanilla | 512 | 512 | 0 | 0 | 3,272 |
| Lunar Magic resave | 512 | 512 | 0 | 0 | 3,272 |
| Grand Poo World 2 1.1 | 512 | 512 | 0 | 0 | 236,068 |
| GrandPooWorld V1.2 | 512 | 512 | 0 | 0 | 46,176 |
| Invictus 1.0 | 512 | 512 | 0 | 0 | 347,536 |
| Seven Vanilla Levels | 512 | 512 | 0 | 0 | 20,760 |

Total 3072 compared, 3072 passed, 0 skipped. One machine, one GPU, one run. Without the corpus the only runnable check is the synthetic fixture below (1 clean case plus 4 planted). `[EST]`

## 2. The check goes red on planted defects

Smoke test, not coverage evidence. Each plant changes only the GL arm; the CPU reference is untouched.

| Plant | How | Synthetic fixture (px differing of 27,968) | Corpus levels red, of 3072 |
|---|---|---|---|
| palette row swapped | texture row id + 1 mod rows | 27,423 | 3,069 |
| horizontal flip inverted | flipX negated per blit | 26,689 | 3,069 |
| tile index off by one | atlas slot + 1 | 26,667 | 3,069 |
| priority planes swapped | corpus: `map.passes()` patched so every BG pass draws the other phase; synthetic: the two groups drawn in reverse | 21,921 | 2,987 |

Clean synthetic run: 0 px differ. The synthetic fixture is built in code (64 random tiles with index 0 gaps, 12 random palette rows, two overlapping groups of 1,500 blits with negative offsets, two `fillRect`s) and needs no ROM. The levels that stay green under a plant are ones where the plant changes nothing (for priority: 8 vanilla levels with no overlap between the phases). `[EST]`

## 3. Speed: edit-to-repaint

Both canvases visible, one at a time per arm, arms rotated every iteration, first iteration dropped, each repaint ended with a 1-pixel readback so GPU work is inside the timing. ms, median (IQR).

| Arm | `$10A` 8192x432, 75,612 blits | `$0F7` 512x6656, 58,444 blits |
|---|---|---|
| model walk only (null target) | 9.0 (0.2) | 7.1 (0.3) |
| CPU full repaint | 52.6 (2.8) | 25.9 (2.1) |
| GL full, cold (new context textures) | 35.6 (16.9) | 22.8 (2.6) |
| GL full, warm (atlas kept) | 34.8 (15.4) | 21.7 (1.6) |
| GL full, warm, palette keyed by identity (bound, not parity-checked) | 22.3 (12.9) | 12.4 (0.3) |
| CPU palette-only (= full repaint, no cheaper path) | 52.7 (2.3) | 27.5 (2.3) |
| GL palette-only (row upload + replay) | 7.8 (14.2) | 2.8 (0.1) |
| to next rAF, CPU / GL warm | 56.7 / 45.0 | 26.8 / 22.4 |

31 iterations (15 for the rAF rows), one run, the GPU above. Where the time goes on GL warm: `$10A` walk 24.3 + draw 10.3 (IQR 17.6); `$0F7` walk 18.2 + draw 3.5. The walk is more than the null walk (9.0) because the GL target's `blit8x8` hashes 16 colours per call; keying by array identity (a bound only, wrong under palette animation) drops it to 22.3 and 12.4. `[EST]`

`$10A` draw time is bimodal (2.2 to 42.2 ms). It has 8 alpha segments, each one copying the 14 MB framebuffer; `$0F7` has none and is steady. That attribution is an inference from the segment counts, not a profile. `[INF]`

Sweep: all 512 vanilla ids, 7 iterations each, one run. Ratios are per-level median CPU over GL.

| | median | min | max | levels where GL is faster |
|---|---|---|---|---|
| full, CPU / GL warm | 1.12 | 0.60 | 3.43 | 63.5% |
| full, CPU / GL cold | 0.89 | 0.41 | 2.33 | 33.6% |
| full, CPU / GL warm, identity key (bound) | 1.86 | 0.90 | 5.23 | 99.2% |
| palette-only, CPU / GL | 3.73 | 1.00 | 54.25 | 100% |

By CPU repaint cost: under 5 ms (311 levels) full 1.00x, palette 3.3x; 5 to 15 ms (130) full 1.25x, palette 4.9x; over 15 ms (71) full 1.48x, palette 10.2x, GL palette-only median 2.4 ms against CPU 24.6. Levels with alpha segments (62): full 1.20x; without (450): 1.11x. `[EST]`

Not measured: a real palette edit end to end. The CPU arm repaints the same model; the GL arm rotates one texture row. An edit that changes tiles still pays the walk. `[OPEN]` Resolve by wiring the harness to the project edit path.

## 4. JSON-RPC bytes

Today's figure is `JSON.stringify(mapScreen(...))` summed over every screen, all planes, vanilla, `L1ModelCache`, no switches. The indexed figure is recorded from the same level's `blit8x8` calls: 8 bytes per instance (x, y, tile as u16, row and flags as u16), 64 bytes per unique tile (1 byte per pixel), 48 bytes per palette row, then base64. Sprites are in neither. One run per level, deterministic.

| level | screens | today | indexed (base64) | ratio | indexed, instances gzipped |
|---|---|---|---|---|---|
| `$10A` | 32 | 51,918,406 | 820,288 | 63x | 210,456 |
| `$0F7` | 26 | 18,186,678 | 628,056 | 29x | 131,560 |
| `$105` | 20 | 24,781,434 | 449,476 | 55x | 97,588 |
| `$125` | 32 | 38,352,692 | 699,160 | 55x | 137,840 |
| `$1EC` | 16 | 26,548,684 | 153,516 | 173x | 36,792 |
| `$104` | 1 | 1,180,094 | 37,124 | 32x | 9,172 |

Across the 12 levels sampled (those six plus `$11E $024 $1F8 $001 $111 $1D2`): 258.3 MB against 4.24 MB. The two arms come from different renderers (planes via `renderMap16Tile`, instances via the model), so the instance count is the model's, not a re-encoding of the shipped planes. A per-cell tilemap would drop the x and y fields; not built. `[EST]` for the sizes, `[INF]` for the tilemap saving.

## 5. Memory

JS heap: `usedJSHeapSize` delta after render with the result kept alive, one arm per fresh page, 3 runs each, `--expose-gc`. CPU 14,275,670 B (`$10A`) and 13,748,790 B (`$0F7`), equal to `w*h*4` within 0.4%; GL 4,340,033 B and 3,285,597 B. Most of the GL figure is the CPU-side staging (a 4 MiB atlas array plus the instance array, 2.0 MiB on `$10A`), which could be freed after upload. `[EST]`

GPU texture memory is calculated, not observed (no driver query). `$10A`:

| item | arithmetic | bytes |
|---|---|---|
| render target | 8192 x 432 x 4 | 14,155,776 |
| tile atlas | 1024 x 2048 x 1 | 2,097,152 |
| palette texture | 16 x 256 x 4 | 16,384 |
| instance buffer | 75,612 x 16 | 1,209,792 |
| alpha framebuffer copy | 8192 x 432 x 4 (only when a segment has alpha) | 14,155,776 |
| total | | 31,634,880 |

`$0F7` has no alpha segment: 13,631,488 + 2,097,152 + 16,384 + 935,104 = 16,680,128. The CPU arm's 2D canvas backing store (about `w*h*4`) was not observed either. The atlas is oversized for these maps (9,984 of 2,097,152 bytes used on `$10A`); a smaller capacity is a free saving. `[EST]` for the sums, `[OPEN]` for real driver allocation.

## 6. Palette animation

One palette row cycled every 4 frames over 240 rAF frames, visible window. GL: row upload, replay, 1-pixel readback. CPU: `setPalAnimFrame` plus full re-render and flush. ms.

| | update-frame cost, median (p95) | mean cost per frame | frame intervals over 25 ms |
|---|---|---|---|
| `$10A` GL | 17.6 (20.3) | 4.47 | 0 |
| `$10A` CPU | 56.0 (65.5) | 14.45 | 60 |
| `$0F7` GL | 3.1 (3.4) | 0.72 | 1 |
| `$0F7` CPU | 28.4 (29.9) | 7.23 | 3 |

Idle baseline: median interval 18.0 ms. On `$10A` the CPU arm misses a frame on a quarter of frames (60 of 240); the GL arm does not, but its 17.6 ms update frame is nearly a whole frame budget and is dominated by the 8 framebuffer copies, not by the palette. The CPU arm's re-render uses the model's own cycling colours; the GL arm rotates a row as a stand-in, so only the cost is comparable, not the picture. One run. `[EST]`

## 7. Context limits

40 canvases, each one `webgl2` context with a clear. Three identical runs.

- Contexts 1 to 16 stay live. Creating the 17th fires `webglcontextlost` on the oldest (context 0). `[EST]`
- At 40 created: 16 alive, 24 distinct contexts lost, 34 lost events (some contexts lost more than once). No exception and no null context: a lost tab silently stops drawing until it is recreated. `[EST]`
- Releasing 10 of the live contexts with `WEBGL_lose_context` did not bring any lost context back within 500 ms (0 `webglcontextrestored`, 6 alive). `[EST]`
- Recreating a context and cold-rendering `$10A` costs 31.5 ms median (IQR 2.5, 7 runs), so a design that frees the context on tab hide and rebuilds on show pays about one cold repaint per switch. `[EST]`
- Not measured: Electron's limit (it is the same Chromium code, not read), and contexts holding real maps. `[OPEN]`

## Recommendation: conditional go

Build it if palette editing or palette animation is a goal, or if the JSON-RPC payload is a problem. Do not build it for full-repaint speed: a 12% median gain does not pay for a second renderer. `[INF]` from sections 1 to 7.

Conditions, each a measured defect above:

1. Extend `RenderTarget` with palette index and tile identity. The colour-array interface forces a 16-colour hash per blit, which is why full repaint is not faster (identity keying alone is 1.86x) and why palette-only is not free of content dedupe.
2. Never one context per tab: share one context, or free it on hide (31.5 ms to rebuild). 17 tabs break per-tab contexts.
3. Bound the alpha framebuffer copy to the segment's bounding box. Eight full copies are 14 MB of the `$10A` GPU total and most of its 17.6 ms animation frame.
4. Shrink the atlas to the map's tile count.

Follow-ups if go, none done here:

- Sprites and OAM priority: sprite pixel arrays are per-call, so identity keying needs a sprite cache; the four OBJ priority passes need pass boundaries the target does not see today.
- SNES colour math (`ColorMath.ts`): it composes screens per pixel on the CPU; a GL path needs main and sub screens as separate render targets, which this design has not tried.
- Mode 7: no tile instances at all; out of reach of this design.
- The shipped widget: it draws `map-screen.ts` planes, not `SmwMap.render`. Moving it onto instances is a protocol change (`MapScreenResult`) and a view rewrite, which no number here prices.

## Reproducing

The harness is not in the repository (about 900 lines in an uncommitted folder, excluded through `.git/info/exclude`); the numbers above are what it produced. It bundles `src/` through Vite, loads a ROM from the corpus directory, and drives a visible Chromium window with Playwright. `[EST]`
