# WebGL2 map renderer: spike findings

> **Bottom line**
>
> - Pixel parity holds: a WebGL2 `RenderTarget` equals the CPU `CanvasRenderTarget` byte for byte on all 3072 corpus levels (6 ROMs x 512 ids), 0 failed; also on the canvas (default framebuffer) path on vanilla, and after a palette-only edit on 3 levels (CPU reference substitutes rows matched by content, the same rule GL uses, so it cannot detect two palette indices with equal colours sharing a row). `[EST]`
> - WebGL does not make a full repaint faster: median 0.93x over 512 vanilla levels, GL slower on 59% of them, because the model walk (`SmwMap.render`) and the per-blit palette-row lookup dominate. Keying rows by array identity, which also passes parity on static palettes, would make it 1.50x. `[EST]`
> - The wins measured here come from an indexed representation, not from WebGL: palette-only repaint (3.1x median against a CPU target that has no cheaper path by harness choice) and payload size (63x smaller raw on `$10A`, but only 3x once both sides are gzipped). `[EST]` Palette-only is a stand-in: a single ROM palette-row edit is not expressible through today's `RenderTarget`, with content or identity keys alike. A CPU indexed compositor was not built, so WebGL over it is unproven. `[OPEN]`
> - The CPU arm is the model path through `CanvasRenderTarget`, not the shipped Theia widget (which draws `map-screen.ts` planes), so no ratio here is against what ships. `[EST]`
> - Chromium evicted the oldest of 17 contexts in the Playwright build; with the emulator holding one, map tabs get at most 15. `[EST]` (Playwright Chromium). Electron's own limit was not measured. `[OPEN]`
> - An indexed map representation is worth a spike against the shipped widget; WebGL over a CPU indexed compositor is unproven. `[PROP]`

## Provenance

| Source | Identifier | As of | Retrieved |
|---|---|---|---|
| Code under test | `origin/develop` at `01ab06f8`, unmodified | 2026-10-10 | 2026-10-10 |
| Harness | uncommitted, by the owner's ruling: a local folder (about 970 lines) in the spike worktree, bundling `src/` through Vite, driven by Playwright. Every number below came from its JSON output, kept in the session scratchpad, not in the repository | 2026-10-10 | 2026-10-10 |
| ROMs | the six in `test/suite/support/corpus.ts` `CORPUS` (vanilla, Lunar Magic resave, four hacks), ids 0..511 each | 2026-10-10 | 2026-10-10 |
| Browser | Playwright Chromium (reports 153.0.0.0), headed, visible, `visibilityState` "visible" on every run, devicePixelRatio 2, flags `--enable-precise-memory-info --js-flags=--expose-gc --ignore-gpu-blocklist --disable-features=CalculateNativeWinOcclusion --mute-audio` | 2026-10-10 | 2026-10-10 |
| GPU and host | NVIDIA GeForce RTX 3050 via ANGLE Direct3D11, driver 32.0.16.1692; Ryzen 9 5950X, 64 GB, Windows 11; display refreshed at about 55 Hz (median rAF interval 18.0 ms) | 2026-10-10 | 2026-10-10 |
| Shipped wire | `MapScreenResult.planes` in `theia/extension/src/common/project-protocol.ts`, from `mapScreen` in `theia/extension/src/node/map-screen.ts` | `01ab06f8` | 2026-10-10 |
| Prior spike | `docs/spikes/per-pass-canvas-spike.md` (hidden panes throttle rAF; harness shape) | `01ab06f8` | 2026-10-10 |

## Question

Can a WebGL2 `RenderTarget` draw the model graph with the same pixels as today's CPU target, and is it worth it?
`SmwMap.render(target)` calls `blit8x8` once per 8x8 subtile; the CPU target writes bytes into one `ImageData`.
The spike swaps only the target.

## Scope and what was not measured

- Sprites are off (`editorStore.setLayerToggle('sprites', false)`): no OAM priority or sprite pixel arrays. Colour math (`ColorMath.ts`) and Mode 7 are untouched. `[EST]`
- Not measured: Electron's Chromium (Theia pins Electron 42.10.0 in `theia/electron-app/package.json`; its Chromium was not read), a second GPU, another OS, compositor memory. `[OPEN]` Resolve by running the harness inside the Electron app.
- `performance.now()` values are multiples of 0.1 ms, so sub-millisecond cells are coarse. One machine, one GPU. `[EST]`
- No run lock was taken. The team protocol's run lock covers Theia builds, Playwright and the unit-test run, and a GPU spike falls outside it as written; one harness process ran at a time. `[EST]`

## Design as built

- One `R8UI` atlas texture holds every tile: 128 tiles per row, 1024 x 2048 texels (32768 tiles, 2 MiB). A tile is keyed by the identity of the `Uint8Array` that `Char.getPixels()` returns, in first-seen order. `$10A` uses 156 tiles. `[EST]`
- Palette rows live in a 16 x 256 `RGBA8` texture. `blit8x8` gets `RgbaColor[]`, not an index. Default key: a hash of the 16 RGB entries (alpha ignored, the CPU writes 255), compared on a hit; the texture row is the order of first appearance of a distinct content in one map. Two palette rows with equal colours share a texture row. `[EST]`
- Alternative key, `fastRows`: the array's identity. `Palette.row()` returns one reused scratch array per row index, so identity is a valid key while palettes are static. It passes full parity on vanilla and Invictus (512 of 512 each), run with a fresh `GlStore` per render (`page.ts:54-55`), not the retained store the speed arm uses. On a cache miss it still falls through to content dedupe (`gl.ts:113-116`), so two palette indices with equal colours still share one texture row. Not checked: a retained store across palette animation, where a reused array holds changing colours. `[OPEN]`
- Rows shorter than 16 are padded with black. The CPU aborts a tile that reads past a short row; parity held, so none did (81,968 short-row blits on vanilla). These rows do not come from `Palette.row`. `[EST]` for the counts, `[INF]` for the source.
- Each `blit8x8` appends one instance (x, y, tile, row | flipX | flipY | alpha) to an `Int32Array`; `commit()` uploads it and the dirty atlas rows; one `drawArraysInstanced(TRIANGLES, 0, 6, n)` draws a segment with `texelFetch` and no filtering. Instance order inside a draw call gives the CPU's overdraw order. `fillRect` ends a segment (0 calls in the corpus with sprites off). `[EST]`
- Hidden-tile blends (alpha < 1) use their own segment: the harness copies the framebuffer and the shader blends from the copy with ties to even, because fixed-function blending rounds ties up. During development the first pass failed 2 of 3 levels by 1 on some channels (about 244 px on `$10A`); that output did not survive, so the cause is inferred. `[INF]` Alpha values are quantised to 1/256 (0 inexact across all 3072 maps). Overlapping alpha tiles inside one segment would read a stale copy; parity held, so none overlapped. `[INF]`

## 1. Pixel parity

Whole-map `readPixels` against the CPU `ImageData` buffer, every id 0..511 per ROM, clear colour = the back-area colour. The run fails if `built` is 0 or `passed + failed` differs from `built` (checked: a run over an unbuildable id exits 1).

| ROM | built | passed | failed | unbuildable | alpha blits |
|---|---|---|---|---|---|
| vanilla | 512 | 512 | 0 | 0 | 3,272 |
| Lunar Magic resave | 512 | 512 | 0 | 0 | 3,272 |
| Grand Poo World 2 1.1 | 512 | 512 | 0 | 0 | 236,068 |
| GrandPooWorld V1.2 | 512 | 512 | 0 | 0 | 46,176 |
| Invictus 1.0 | 512 | 512 | 0 | 0 | 347,536 |
| Seven Vanilla Levels | 512 | 512 | 0 | 0 | 20,760 |

3072 compared, 3072 passed, 0 skipped, 1 run; this table is from the first harness run, and the default path is logically unchanged since (not re-run). Without the corpus only the synthetic fixture runs (1 clean case, 4 planted). Further runs, vanilla: canvas path (default framebuffer, flipped in the shader, un-flipped on read) 512 of 512; identity-keyed rows 512 of 512 (and 512 of 512 on Invictus). Palette-only: after a full draw, one palette row is rewritten and uploaded with `texSubImage2D`, and the replay is compared with a CPU render of the same edited palette (rows matched by content): 0 px differ on `$10A`, `$0F7`, `$105`, where the edit changed 2,268,493, 221,806 and 537,971 px. `[EST]`

## 2. The check goes red on planted defects

A smoke test, not coverage evidence. Each plant changes only the GL arm.

| Plant | How | Synthetic (px differing of 27,968) | Corpus levels red, of 3072 |
|---|---|---|---|
| palette row swapped | texture row id + 1 mod rows | 27,423 | 3,069 |
| horizontal flip inverted | flipX negated per blit | 26,715 | 3,069 |
| tile index off by one | atlas slot + 1 | 26,681 | 3,069 |
| priority planes swapped | corpus: `map.passes()` patched so each BG pass draws the other phase; synthetic: the two groups drawn in reverse | 21,922 | 2,987 |

Clean synthetic run: 0 px differ. The fixture is built in code, no ROM: 64 random tiles with index 0 gaps, 12 random palette rows, two overlapping groups of 1,500 blits with negative offsets, 60 blits at alpha 0.5 over random colours (odd channel sums are rounding ties), two `fillRect`s. Levels that stay green under a plant are ones where the plant changes nothing (8 vanilla levels for priority). No plant exercises the tie-to-even path itself. `[EST]`

## 3. Speed: edit-to-repaint

Both canvases visible, arms rotated each iteration, first iteration dropped, each repaint ended by a 1-pixel readback so GPU work is inside the timing. The CPU arm reuses one `CanvasRenderTarget` (allocation excluded). ms, median (IQR), 31 iterations, 1 run.

| Arm | `$10A` 8192x432, 75,612 blits | `$0F7` 512x6656, 58,444 blits |
|---|---|---|
| model walk only (null target) | 8.7 (0.3) | 6.7 (0.2) |
| CPU full repaint | 50.4 (1.1) | 23.8 (0.6) |
| GL full, cold (new textures) | 35.5 (18.7) | 22.3 (0.5) |
| GL full, warm (atlas kept) | 34.4 (15.6) | 21.2 (0.8) |
| GL full, warm, identity-keyed rows | 21.9 (17.6) | 11.5 (0.4) |
| CPU palette-only (= a full repaint) | 50.7 (1.2) | 24.0 (0.5) |
| GL palette-only (row upload + replay, edited row used by instances) | 8.2 (14.5) | 2.8 (0.2) |
| to next rAF, CPU / GL warm (15 reps) | 53.7 / 44.7 | 24.8 / 21.5 |

GL warm splits into the walk and the draw: `$10A` 23.6 + 10.5, `$0F7` 17.8 + 3.3. The walk exceeds the null walk (8.7) because the GL `blit8x8` hashes 16 colours per call. `[EST]`

`$10A` GL is not unimodal; the median hides it. Sorted, GL warm clusters at 25.2 to 26.5 ms (8 of 31), 29.4 to 38.1 (13), 45 to 49 (9), plus one 71.1. Draw time: 2.2 to 3.2 (8), 4.5 to 12.5 (13), 21.2 to 23.4 (9), plus one 47.5. Palette-only: 1.4 to 1.6 (9), 7.1 to 9.5 (12), 16 to 17.8 (10). `$10A` has 8 alpha segments, each copying the 14 MB framebuffer; `$0F7` has none and is steady (draw 3.0 to 3.5 in 29 of 31). Whether the segments cause the clusters is unprofiled. `[OPEN]` Resolve with a GPU timer query, or a run with alpha segments disabled.

Sweep: all 512 vanilla ids, 7 iterations each, one run; per-level median CPU over GL.

| | median | p10 | p90 | levels where GL is faster |
|---|---|---|---|---|
| full, CPU / GL warm | 0.93 | 0.83 | 1.46 | 41.4% |
| full, CPU / GL cold | 0.73 | 0.64 | 1.29 | 30.3% |
| full, CPU / GL warm, identity-keyed | 1.50 | 1.32 | 2.56 | 97.9% |
| palette-only, CPU palette-only (= full repaint) / GL | 3.10 | 2.30 | 9.22 | 98.8% |
| palette-only, CPU full / GL | 3.00 | 2.2 | 9.35 | not recorded |

By CPU repaint cost: under 5 ms (343 levels) full 0.88x, palette-only 2.73x (GL 1.1 ms against CPU 3.0); 5 to 15 ms (107) 1.27x and 5.46x (1.3 against 6.7); over 15 ms (62) 1.32x and 8.95x (2.4 against 20.9). `[EST]`

The palette-only rows compare an indexed repaint with a CPU target that cannot do one. They measure the value of a retained, indexed representation, not of WebGL. Not measured: a real ROM palette edit end to end; content-keyed rows cannot express one ROM palette row through today's interface (identity keying does not either: it falls through to content dedupe on a miss). `[OPEN]` Resolve with a palette-index interface and a CPU indexed compositor as the control.

## 4. JSON-RPC bytes

Today: `JSON.stringify(mapScreen(...))` for every screen, all planes, vanilla. Indexed: recorded from the same level's `blit8x8` calls, 8 bytes per instance, 64 per unique tile (1 byte per pixel), 48 per palette row, then base64. Both arms raw and gzipped (gzip of the concatenated JSON; of instances and tiles separately for the indexed arm; palette rows uncompressed). Today's planes come from `renderMap16Tile`, the indexed arm from the model, so instance counts are the model's. Sprites are in neither. Bytes, deterministic.

| level | screens | today raw | today gzip | indexed b64 | indexed gzip |
|---|---|---|---|---|---|
| `$10A` | 32 | 51,918,406 | 641,412 | 820,288 | 210,456 |
| `$0F7` | 26 | 18,186,678 | 177,775 | 628,056 | 131,560 |
| `$105` | 20 | 24,781,434 | 199,917 | 449,476 | 97,588 |
| `$125` | 32 | 38,352,692 | 216,252 | 699,160 | 137,840 |
| `$1EC` | 16 | 26,548,684 | 180,672 | 153,516 | 36,792 |

The widget fetches the visible screens plus a margin of 1, lazily and cached (`map-view-widget.tsx:107,454-470`), so a window of 4 screens is the fairer unit. First 4 screens (`$0F7` is vertical and windowed by y):

| level | today raw | today gzip | indexed b64 | indexed gzip | indexed per screen, whole map |
|---|---|---|---|---|---|
| `$10A` | 7,079,620 | 74,977 | 96,748 | 27,652 | 25,634 |
| `$105` | 4,720,356 | 38,771 | 98,072 | 23,332 | 22,474 |
| `$125` | 4,720,356 | 26,161 | 92,992 | 20,352 | 21,849 |
| `$1EC` | 5,899,892 | 44,037 | 39,148 | 10,872 | 9,595 |
| `$0F7` | 2,797,948 | 36,018 | 112,536 | 24,468 | 24,156 |

Raw, the window is 25x to 151x smaller (`$0F7` 25x, `$10A` 73x, `$1EC` 151x). The gzip comparison is not a strict bound: today is gzipped as one stream (`bytes.ts:82`), valid only with deflate context takeover across messages; the indexed arm is gzip then base64 (`bytes.ts:86,90`, +1.33x) with palette rows uncompressed. On that basis the gzipped ratio is 1.3x to 4.1x over the 5 tabled windows and 1.29x to 4.38x over all 12 sampled levels. Twelve levels were sampled (those plus `$11E $024 $1F8 $001 $111 $1D2`); the other seven are in the harness output, not tabled. Whether the Theia JSON-RPC channel compresses was not checked, so raw and gzipped are two readings, not bounds. `[OPEN]` Resolve by reading the websocket extension negotiation in a running Theia.

## 5. Memory

JS heap: `usedJSHeapSize` delta after one render with the result kept alive, one arm per fresh page, `--expose-gc`, 3 runs each, bytes.

| arm | `$10A` runs | `$0F7` runs |
|---|---|---|
| CPU (ImageData) | 14,275,594 / 14,275,610 / 14,275,670 | 13,748,242 / 13,749,102 / 13,748,242 |
| GL (staging arrays) | 4,340,637 / 4,340,701 / 4,340,013 | 3,285,557 / 3,285,581 / 3,285,557 |

The CPU delta is +0.85% over `w*h*4` (14,155,776 on `$10A`). The GL figure is CPU-side staging: a 2 MiB atlas array plus the instance array (2 MiB on `$10A`), freeable after upload. `[EST]`

GPU texture memory is calculated, not observed. `$10A`:

| item | arithmetic | bytes |
|---|---|---|
| render target | 8192 x 432 x 4 | 14,155,776 |
| tile atlas | 1024 x 2048 x 1 | 2,097,152 |
| palette texture | 16 x 256 x 4 | 16,384 |
| instance buffer | 75,612 x 16 | 1,209,792 |
| alpha framebuffer copy (only with an alpha segment) | 8192 x 432 x 4 | 14,155,776 |
| total | | 31,634,880 |

`$0F7`, no alpha segment: 13,631,488 + 2,097,152 + 16,384 + 935,104 = 16,680,128. Totals on `$10A`: GL 4.3 MB heap + 31.6 MB GPU; CPU 14.3 MB heap + a 2D canvas backing store of about 14.2 MB, not observed, so about 28.5 MB. `[INF]` for the CPU backing store and both sums, `[OPEN]` for real driver allocation. The atlas is oversized (9,984 of 2,097,152 bytes used on `$10A`).

## 6. Palette animation

One palette row cycled every 4 frames over 240 rAF frames, visible window, 3 runs. GL: row upload, replay, readback. CPU: `setPalAnimFrame` and a full re-render with a reused target. Update-frame cost in ms, median (min) per run.

| | run 1 | run 2 | run 3 | frames over 25 ms, per run |
|---|---|---|---|---|
| `$10A` GL | 21.2 (20.4) | 17.8 (16.2) | 17.7 (16.9) | 0 / 0 / 0 |
| `$10A` CPU | 51.8 (49.5) | 51.3 (49.6) | 51.4 (50.2) | 60 / 60 / 60 |
| `$0F7` GL | 3.1 (2.2) | 4.3 (2.4) | 3.1 (2.1) | 0 / 0 / 0 |
| `$0F7` CPU | 25.4 (24.4) | 24.9 (24.1) | 25.7 (24.3) | 2 / 3 / 2 |

Idle frames over 25 ms, per 240: 1 in every `$10A` run, 1, 1 and 2 in the `$0F7` runs. The display ran at about 55 Hz (18.0 ms), so a 17.7 ms GL frame fits one refresh here. At 60 Hz the budget is 16.7 ms and every `$10A` GL update frame (min 16.2, median 17.7 to 21.2) exceeds it, so the 0-against-60 contrast is partly a 55 Hz artifact. The CPU's 60 of 240 is every update frame (51 ms is three refreshes) and is not. The GL arm rotates a row as a stand-in for the model's cycling colours, so only cost compares, not the picture. `[EST]`

## 7. Context limits

40 canvases, one `webgl2` context each, three identical runs, `webglcontextrestored` listener attached before the loop.

- Creating the 17th fires `webglcontextlost` on the oldest (context 0). At 40 created: 16 alive, 24 evicted during creation. 34 lost events in all: those 24 plus 10 from the harness's own `loseContext()` calls afterwards. `[EST]`
- 0 `webglcontextrestored` events, and releasing 10 live contexts did not bring any evicted one back within 500 ms (6 alive). No exception, no null context: an evicted tab silently stops drawing. `[EST]`
- Whether 16 is per page, per renderer process or per GPU process was not distinguished. `[OPEN]`
- The emulator widget binds its canvas as webgl2 (`theia/extension/src/browser/emulator-driver.ts:397`), so map tabs get at most 15, and eviction takes the oldest, which could be the emulator. `[INF]`
- Recreating a context and cold-rendering `$10A` costs 31.5 ms median (IQR 2.5, 7 runs, earlier run of the same harness). `[EST]`
- Electron's limit was not measured. `[OPEN]`

## Recommendation `[PROP]`

Do not build WebGL for full-repaint speed: 0.93x median with content-keyed rows, 1.50x with identity-keyed rows (parity on static palettes, fresh store). Worth a spike against the shipped widget: an indexed map representation (retained tile and palette tables, an instance or tilemap list), which is where the palette-only and payload gains came from. WebGL over a CPU indexed compositor is unproven; that control was not built. `[PROP]`

Conditions if any GL path follows:

1. Row keys: identity keying passed parity on static palettes with a fresh store per render and cuts the walk 1.5x; it still shares a texture row between equal-colour palette indices, so it cannot express a single ROM palette-row edit. Whether it survives palette animation on a retained store, and what palette-index interface a single-row edit needs, are open. `[OPEN]`
2. Never one context per tab: share one or free it on hide (31.5 ms to rebuild); map tabs get at most 15. `[PROP]`
3. Bound the alpha framebuffer copy to the segment's box; 8 full copies are 14 MB of the `$10A` GPU total. `[PROP]`
4. Shrink the atlas to the map's tile count. `[PROP]`

Follow-ups if go, none done here:

- Sprites and OAM priority: sprite pixel arrays are per-call, so identity keying needs a sprite cache, and four OBJ priority passes need pass boundaries the target does not see. `[PROP]`
- SNES colour math (`ColorMath.ts`): composes screens per pixel on the CPU; a GL path needs main and sub screens as separate targets. `[PROP]`
- Mode 7: no tile instances; outside this design. `[PROP]`
- The shipped widget: it draws `map-screen.ts` planes, not `SmwMap.render`; moving it onto instances is a protocol and view change no number here prices. `[PROP]`
