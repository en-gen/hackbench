# #825 spike: an indexed map representation against RGBA over RPC

Status: COMPLETE. Wire bytes, the byte-identity oracle, the planted defect and the browser bench
(3 fresh-page runs per arm per map) are measured.

Prototype: `tools/scripts/spike-825/` (`encode.ts`, `gen.ts`, `bench/`). Not imported by shipped
code, not for merge. No shipped file was changed. (`tools/spikes/` is gitignored, hence the path.)

## 1. Evidence scope

All numbers: vanilla SMW (USA) ROM, maps $10A, $105, $101, first 8 screens of each (all 8 of $101;
8 of 32 and 8 of 20 for the others), switches off, one Windows machine, Node 26. Sizes are exact
byte counts of this run and deterministic; they say nothing about hacks with other palettes or tile
variety. Compression is Node zlib gzip level 6 and brotli default, on the JSON text of one reply.

## 2. Encoding and oracle

Per plane: a tilemap of 8x8 cells (u16: tile, palette row, flipX, flipY; priority is the plane),
an origin offset (ox, oy) for the L2 `dy` and L3 scroll that are not multiples of 8, and a per-map
deduplicated tile set of 64 palette-index bytes. CGRAM travels as BGR555 (512 B for the map,
64 B for layer 3's 2bpp palettes). The encoder re-walks the placement loops of `drawPlanes` and
`drawL3Planes` (it could not wrap them: they take RGBA, not indices), so the walk is duplicated
in the spike; a shipped version would have the draw path emit cells directly.

Oracle (`gen.ts`): the reference decoder `decodePlane` output is compared byte for byte with the
RGBA that `screenResult` sends. Result: byte-identical on 24 screens (8 each of $10A, $105, $101),
all 6 planes each, one machine. Planted defect (palette row + 1): all 62 drawn planes went red.
Ghost cells (hidden-switch screen door, RGBA with no index form) numbered 0 on these maps; on a
map with switch blocks they need an escape path (RGBA patch cells), not exercised here.

## 3. Wire bytes (per screen, average of 8 screens; per-map shared tile set + CGRAM)

| Map | Arm | raw | JSON (base64) | gzip | brotli |
|---|---|---|---|---|---|
| $10A | RGBA per screen | 1,327,104 | 1,769,939 | 19,943 | 9,856 |
| $10A | indexed per screen | 10,392 | 14,056 | 1,801 | 1,531 |
| $10A | indexed per map (shared) | 6,464 | 8,656 | 2,218 | 1,905 |
| $105 | RGBA per screen | 884,736 | 1,180,123 | 9,992 | 5,531 |
| $105 | indexed per screen | 6,928 | 9,398 | 934 | 832 |
| $105 | indexed per map (shared) | 10,816 | 14,460 | 3,186 | 2,529 |
| $101 | RGBA per screen | 1,216,512 | 1,622,483 | 18,616 | 7,108 |
| $101 | indexed per screen | 9,526 | 12,892 | 1,057 | 926 |
| $101 | indexed per map (shared) | 6,208 | 8,316 | 2,282 | 1,940 |

Whole 8 screens, JSON then gzip: $10A RGBA 14.16 MB / 159.5 KB, indexed 121 KB / 16.6 KB;
$105 RGBA 9.44 MB / 79.9 KB, indexed 89.6 KB / 10.7 KB; $101 RGBA 12.98 MB / 148.9 KB, indexed
111 KB / 10.7 KB. Indexed is about 125x smaller uncompressed; gzipped RGBA is only about 7x to
14x larger than gzipped indexed, because flat-colour pixel art compresses extremely well.

## 4. Browser bench

Evidence scope: headless Chromium 153.0.8010.12 (Playwright 1.63, headless shell), one Windows
machine, WebGL on ANGLE over SwiftShader (software Vulkan, NO GPU: arm C numbers are a software
floor and a real GPU would likely be faster), 3 fresh pages per arm per map, maps $10A, $105,
$101 (vanilla), first 8 screens each, 768x432 viewport, screens 256x432. Standalone page
(`bench/bench.html`), NOT the Theia widget: no RPC, no sprites or overlays, one plane canvas per
layer plane as the widget stacks them. Cells are ranges over the 3 runs. Raw per-run JSON:
`fixtures/results.json` in the session scratchpad (ROM-derived, not committed).

Definitions: first paint = arm setup (worker start / GL init + shader compile) through 4 screens
painted and 2 rAFs. Decode = main-thread ms per screen (A: base64 decode + putImageData for all
planes; B: postMessage + drawImage only; C: tilemap upload + draw + copy to the plane canvas).
Scroll = rAF frame interval over 80 frames of 16 px/frame, screens 4-7 built on demand one
screen ahead. Heap = `usedJSHeapSize` after gc once all 8 screens are shown, with the arm's
parsed payload still held (A holds the base64 strings, B and C the small indexed payload).
Palette edit = one palette row changed, 4 visible screens repainted (A has no equivalent: it
needs a new server reply).

| Map | Arm | first paint 4 screens (ms) | decode p50 / p95 per screen (ms) | scroll p50 / p95 / max (ms) | heap (MB) | palette edit, 4 screens (ms) |
|---|---|---|---|---|---|---|
| $10A | A RGBA | 292-300 | 69.3-72.3 / 74.3-77.8 | 16.5-16.6 / 68.6-73.0 / 69.5-80.3 | 14.8 | n/a |
| $10A | B CPU worker | 44-59 | 0.4-0.5 / 0.6-0.7 | 16.7 / 17.6-17.8 / 18.1-18.3 | 1.4 | 15.6-17.2 |
| $10A | C WebGL2 | 58-137 | 7.1-7.9 / 24.2-48.7 | 16.6 / 17.7-17.8 / 18.1-18.4 | 1.5 | 31.3-33.4 |
| $105 | A RGBA | 199-370 | 47.8-88.8 / 56.1-97.6 | 16.6-16.7 / 48.2-90.1 / 58.8-101.5 | 10.3 | n/a |
| $105 | B CPU worker | 46-76 | 0.4-0.8 / 0.5-1.0 | 16.7 / 17.7-17.9 / 17.9-18.7 | 1.4 | 16.1-16.7 |
| $105 | C WebGL2 | 58-73 | 6.7-7.1 / 23.5-34.7 | 16.5-16.7 / 17.6-17.8 / 17.9-18.1 | 1.5 | 25.9-30.6 |
| $101 | A RGBA | 448-462 | 125.1-130.8 / 141.0-144.5 | 16.6-16.7 / 121.4-132.3 / 135.0-137.6 | 13.6 | n/a |
| $101 | B CPU worker | 53-58 | 0.8-0.9 / 1.1 | 16.6-16.7 / 17.6-17.9 / 17.9-18.3 | 1.4 | 15.9-32.4 |
| $101 | C WebGL2 | 69-74 | 9.2-10.3 / 31.3-33.8 | 16.6-16.7 / 17.6-17.7 / 17.8-18.1 | 1.5 | 32.4-36.7 |

Worker time (B, off the main thread): 2.3-5.5 ms mean per screen across the three maps.
Canvas backing store is the same in all arms (upper bound 20.3 MB for 8 screens x 6 planes
x 256x432x4); C adds an atlas + palette texture of 10-18 KB. Those are estimates, not GPU
measurements.

Reading: A blocks the main thread 48-131 ms per screen (a dropped-frame spike in every scroll
that builds a screen: p95 49-132 ms against a 16.7 ms frame). This is higher than the #989
baseline of 3.5-9 ms because this bench counts every plane's decode plus putImageData of six
full-screen canvases in software-rendered headless Chromium; do not compare absolutely, compare
across arms in this run. B and C keep p95 at 17.6-17.9 ms (the 60 Hz frame). C's per-screen main
cost (7-10 ms p50, up to 49 ms p95) is higher than B's under SwiftShader, and its palette edit
is slower, not faster. B's palette edit has one 32 ms outlier run on $101.

## 5. Answers to the open questions

(a) Palette-row edits. `RenderTarget.blit8x8` takes `paletteRow: RgbaColor[]` already resolved, so
the draw path loses which row a pixel came from. The fix is an indexed interface:
`blitCell(tile, row, flipX, flipY, priority)` plus `setTileSet(indices)` and `setPalette(cgram)`,
with a CPU implementation (this spike's `decodePlane`, i.e. the `CanvasRenderTarget` loop with the
colour lookup moved to flush time) and a GPU one. A palette edit then re-runs only the lookup: no
server round trip and no re-walk of the objects. Today's path cannot express it: an edit means a
new RGBA reply per screen.

(b) CPU control arm. `decodePlane` (Node) and `raster()` in `bench.js` (browser, arm B in a Worker)
are the CPU indexed compositor; arm C (WebGL2) is to be judged against it, not only against arm A.

(c) Compression on the channel. Source evidence, `@theia/core` 1.75.0 in the installed tree:
`node/messaging/websocket-endpoint.js` builds `new socket_io.Server(server, {pingInterval,
pingTimeout, maxHttpBufferSize, allowRequest, ...})` with no `perMessageDeflate`; engine.io
applies it only when set and `ws` 8.21.3 defaults it to false. So the browser build's JSON-RPC
frames travel uncompressed (read from source, not captured on the wire). Electron: backend
services use `electron-ws-connection-source` (the same socket.io transport to the local backend
process); `ElectronIpc*` carries only main-process services. Either way the hop is loopback, so
compression buys nothing locally; it matters only for a remote browser deployment. A server-side
`perMessageDeflate: {threshold: 1024}` would shrink today's replies roughly 90x (JSON to gzip,
table 3) at server CPU cost, but the base64 string is still decoded on the UI thread (3.5-9 ms per
screen in the #989 baseline, not re-measured here).

## 6. Options for the owner

1. Keep RGBA, no compression. Zero cost. The local wire (1.2-1.8 MB per screen) is irrelevant on
   loopback; UI-thread decode and 65-70 ms of backend draw per screen stay.
2. Keep RGBA, enable permessage-deflate. Small backend bootstrap change; helps only a remote
   browser, not decode and not palette edits.
3. Indexed + CPU Worker (arm B). About 125x smaller payload, off-thread decode, palette edits
   without a round trip. Cost: an indexed draw path in the core (the spike duplicates the
   placement loops; the real work is making them the single source), an escape for ghost cells,
   and a RenderTarget interface change. Lowest-risk indexed option.
4. Indexed + WebGL2 (arm C). Same payload; adds shader code, context-loss handling and
   GPU-blocklist risk. Measured slower than B on software GL; untested on a real GPU.

Recommendation: option 3, indexed + CPU Worker. On this bench it cut main-thread cost per
screen from 48-131 ms to 0.4-0.9 ms, held scroll p95 at 17.6-17.9 ms where RGBA reached 49-132 ms,
cut first paint from 199-462 ms to 44-76 ms, retained heap from 10-15 MB to 1.4 MB, and
repainted 4 screens after a palette edit in 16-32 ms with no server round trip. Why not the
others: option 1 and 2 leave the 48-131 ms main-thread stalls and cannot express a palette edit;
option 4 (WebGL2) measured slower than the CPU worker here (decode p95 24-49 ms, palette edit
26-37 ms) on a software renderer, so it is not justified until a real-GPU run shows otherwise.

## 7. What this does not cover

The standalone page is not the shipped widget: no sprites, collision or block overlays, no
priority or colour-math compositing, no Theia messaging, no real RPC latency, no cache
invalidation on ROM edit. Backend draw time (65-70 ms/screen) is not changed by this spike; an
indexed path may cut it, unmeasured. Fixtures hold the first 8 screens of three vanilla maps only.
