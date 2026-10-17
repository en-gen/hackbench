# #825 spike: an indexed map representation against RGBA over RPC

Status: PARTIAL. Wire bytes, the byte-identity oracle and the planted defect are measured.
The browser bench (arms A/B/C) is built and committed but NOT RUN: the shared run lock was
reserved by a queue of nine other teams for over 90 minutes (2026-10-17), and the brief forbids
Playwright without it. Section 4 therefore has no numbers; run `bench/run.cjs` under one lock hold.

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

## 4. Browser bench (NOT RUN, see status)

`bench/bench.html` + `bench.js` (standalone page, not the Theia widget) measure, per arm, in a
fresh page: setup + first paint of 4 screens, per-screen main-thread decode ms (p50/p95), worker
ms (B), palette-row-edit repaint of 4 screens (B, C), scripted scroll frame p50/p95/max with
screens built on demand one screen ahead, JS heap after gc, canvas bytes (upper-bound estimate)
and the GL renderer string. `bench/run.cjs <fixturesDir> <playwrightDir>` runs 3 fresh pages per
arm per map and prints ranges. Fixtures come from `gen.ts` into a directory outside the repo
(ROM-derived, never committed). Table to be filled by that run:

| Arm | first paint 4 screens | decode p50/p95 | scroll p50/p95/max | heap | palette edit |
|---|---|---|---|---|---|
| A RGBA + putImageData | pending | pending | pending | pending | n/a |
| B indexed CPU Worker | pending | pending | pending | pending | pending |
| C indexed WebGL2 | pending | pending | pending | pending | pending |

The bench code has not executed once, so expect small fixes on its first run.

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
4. Indexed + WebGL2 (arm C). Same payload, potentially the fastest palette edits; adds shader
   code, context-loss handling and GPU-blocklist risk (software fallback). Justified only if
   section 4 shows B missing the frame budget.

Recommendation: do not choose until section 4 is filled. Absent that, option 3 is the
better-bounded bet, and option 4 only as a measured follow-up.

## 7. What this does not cover

The standalone page is not the shipped widget: no sprites, collision or block overlays, no
priority or colour-math compositing, no Theia messaging, no real RPC latency, no cache
invalidation on ROM edit. Backend draw time (65-70 ms/screen) is not changed by this spike; an
indexed path may cut it, unmeasured. Fixtures hold the first 8 screens of three vanilla maps only.
