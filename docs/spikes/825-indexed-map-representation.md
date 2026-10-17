# #825 spike: an indexed map representation against RGBA over RPC

Status: wire bytes and the oracle are measured. The browser bench (section 4) is RE-RUN PENDING:
the first run was invalidated by review (it used a slow base64 decoder in arm A and left out the
widget's composite), its numbers are withdrawn, and the corrected bench awaits a run-lock slot.

Prototype: `tools/scripts/spike-825/` (`encode.ts`, `gen.ts`, `bench/`). Not imported by shipped
code, not for merge. No shipped file was changed. (`tools/spikes/` is gitignored, hence the path.)

## 1. Evidence scope

All numbers: vanilla SMW (USA) ROM, maps $10A, $105, $101, first 8 screens of each (all 8 of $101;
8 of 32 and 8 of 20 for the others), switches off, one Windows machine, Node 26. Sizes are exact
byte counts of this run and deterministic; they say nothing about hacks with other palettes or tile
variety. Compression is Node zlib gzip level 6 and brotli default, on the JSON text of one reply (the live frame is msgpackr, see 5c).

## 2. Encoding and oracle

Per plane: a tilemap of 8x8 cells (u16: tile, palette row, flipX, flipY; priority is the plane),
an origin offset (ox, oy) for the L2 `dy` and L3 scroll that are not multiples of 8, and a per-map
deduplicated tile set of 64 palette-index bytes. CGRAM travels as BGR555 (512 B for the map,
64 B for layer 3's 2bpp palettes). The encoder re-walks the placement loops of `drawPlanes` and
`drawL3Planes` (it could not wrap them: they take RGBA, not indices), so the walk is duplicated
in the spike; a shipped version would have the draw path emit cells directly.

Oracle (`gen.ts`): the reference decoder `decodePlane` output is compared byte for byte with the
RGBA that `screenResult` sends, every plane of every checked screen. Result, one machine, vanilla
ROM, first 8 screens per map (4 for $BE): byte-identical on 44 screens of six maps. Plane kinds
actually drawn, per map: $10A l1Low l1High l2Low; $105 l1Low l2Low; $101 l1Low l1High l2Low; $115
l1Low l1High l2Low l3Low; $BE and $02 l1Low l2Low l3High. A scan of all 488 buildable vanilla maps
(first 8 screens) found l2High drawn by NONE, so that plane kind is unexercised by any vanilla map
(it needs a hack); l3Low occurs in 12 maps, l3High in 8, l1High in 72.

Planted defects, drawn planes that went red / drawn: palette row + 1: l2Low 43/43, l1Low 44/44,
l1High 15/15, l3Low 8/8, l3High 12/12. Dropped horizontal flip: the same counts, so a layer 3 flip
bug would be caught.

Ghost cells (hidden-switch screen door, RGBA with no index form): 0 in every checked screen, but
vanilla $10A has 6 of them over its full 32 screens (a census with switches off; they sit past
screen 8). The encoder counts them and does not encode them, so the oracle would go red on the full
$10A: vanilla $10A needs an escape path (per-cell RGBA patches) that this spike did not build.
The tile index is 11 bits (2046 distinct chars per map); `tileOf` throws past it. Output of
`gen.ts` is ROM-derived and the script refuses an output directory inside the repo.

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

## 4. Browser bench (RE-RUN PENDING)

The first run's numbers are withdrawn. Review found (1) arm A decoded base64 with
`Uint8Array.from(atob(s), fn)` (about 30 ms a plane) instead of the shipped loop; it now ports
`decodeBase64Bytes` (`map16-pixels.ts:22-27`) exactly; (2) the widget does not paint planes alone:
`paintComposite` runs `composeScreen` (color math over the plane RGBA) and puts the result on a
composite canvas, beside the plane canvases kept by `sync`. Arm A now does both, with the real
`ColorMath.composeScreen` bundled into the page; (3) the heap figure was an artifact (arm A held
the fixture strings, ImageData bytes sit outside `usedJSHeapSize`) and is dropped.

Bench definitions (fixed in the code, numbers to come): first paint = arm setup through 4 screens
painted; decode = main-thread ms per screen; e2e = start to drawn, including the worker for B;
scroll = rAF intervals over 80 frames, screens 4-7 built on demand; palette edit = one row
changed, 4 visible screens repainted. B's main-thread figure (post + drawImage) excludes the
deferred bitmap upload, so e2e is reported beside it. The page is standalone, not the widget:
no sprites (doors null), no layer toggles.

The composite and the indexed arms. `composeScreen` reads plane RGBA, it cannot consume an
ImageBitmap or a GL texture. Arm B therefore runs the composite in the worker (`importScripts`
of the bundled `composeScreen`), returning plane and composite bitmaps; its worker ms now include
the composite, which is the per-pixel allocation heavy code (about 140 ms a screen in Node, one
run, unrepresentative). Moving it for real needs the door/flip/lift state (sprite door ids,
`doorFlips`, the lifted id, layer toggles) posted to the worker on every change, and every toggle
or hover re-composites there. Arm C has no composite: it would need either a readback of each
plane (`readPixels`) feeding the CPU `composeScreen` (cost: readback plus the composite measured
in arm A, so the GPU buys nothing for painting), or porting ColorMath (CGADSUB, half, fixed color,
backdrop, partial-alpha blend, door screen door and lift, about 260 lines of branchy code) to a
shader: a multi-day job with its own oracle. Arm C numbers will cover plane drawing only.

Table: pending (run `bench/run.cjs`; evidence scope will be machine, Chromium build, SwiftShader
or GPU, 3 fresh pages per arm per map, maps $10A $105 $101).

## 5. Answers to the open questions

(a) Palette-row edits. `RenderTarget.blit8x8` takes `paletteRow: RgbaColor[]` already resolved, so
the draw path loses which row a pixel came from. The fix is an indexed interface:
`blitCell(tile, row, flipX, flipY, priority)` plus `setTileSet(indices)` and `setPalette(cgram)`,
with a CPU implementation (this spike's `decodePlane`, i.e. the `CanvasRenderTarget` loop with the
colour lookup moved to flush time) and a GPU one. A palette edit then re-runs only the lookup: no
server round trip and no re-walk of the objects. Today's path cannot express it: an edit means a
new RGBA reply per screen.

(b) CPU control arm. `decodePlane` (Node) and `raster()` in `bench.js` (browser, arm B in a Worker)
are the CPU indexed compositor; arm C (WebGL2) is judged against it, not only against arm A.

(c) Compression on the channel. Source evidence, `@theia/core` 1.75.0 in the installed tree, read
from source and not captured on the wire. `node/messaging/websocket-endpoint.js` builds
`new socket_io.Server(server, {pingInterval, pingTimeout, maxHttpBufferSize, allowRequest, ...})`
with no `perMessageDeflate`; engine.io applies it only when set and `ws` 8.21.3 defaults it to
false, so after the upgrade the websocket transport is uncompressed. During the polling phase
engine.io's `httpCompression` (threshold 1024) applies, which is a handshake-time path, not the
steady state. The frames are msgpackr-encoded RPC (`@theia/core` depends on msgpackr), not
JSON-RPC text, and carry the base64 strings as they are: the "JSON" columns in section 3 are
therefore a proxy for frame size, not a capture. Electron: backend services use
`electron-ws-connection-source` (the same transport to the local backend process);
`ElectronIpc*` carries only main-process services. The hop is loopback either way, so compression
buys nothing locally; it matters only for a remote browser deployment. A server-side
`perMessageDeflate: {threshold: 1024}` would shrink today's replies roughly 90x (JSON to gzip,
section 3) at server CPU cost, but the base64 string is still decoded on the UI thread.

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

Recommendation: provisional, option 3 (indexed + CPU Worker), to be confirmed or reversed by the
re-run. The payload result (about 125x smaller uncompressed, 7x to 14x after gzip) and the palette
edit without a round trip are structural; the CPU arm needs no GPU and keeps the composite
possible in the worker. Whether it also removes the main-thread stalls must come from the
corrected section 4, which includes the composite for A and B. Options 1 and 2 cannot express a
palette edit. Option 4 is only worth a real-GPU run after the composite question is answered
(a shader port of ColorMath, or readback that defeats the point).

## 7. What this does not cover

The standalone page is not the shipped widget: no sprites, collision or block overlays, no
priority or colour-math compositing, no Theia messaging, no real RPC latency, no cache
invalidation on ROM edit. Backend draw time (65-70 ms/screen) is not changed by this spike; an
indexed path may cut it, unmeasured. Fixtures hold the first 8 screens of three vanilla maps only.
