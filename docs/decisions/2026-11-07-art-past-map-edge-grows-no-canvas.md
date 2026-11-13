Ruled 2026-11-07 (Brian)

# Art past a map's edge grows no canvas; a placement off the map does

## Question

D76 call 2 let the map view's canvas grow to hold every sprite box, so a sprite part past the bottom of $01B added an empty 16 px row across the whole map. Should art that spills past an edge still grow the canvas?

## Options considered

1. Keep padding for every sprite box (D76 call 2 as built in #1004).
2. Cut art at the map's edge on every side and grow only for content the data places off the map.
3. Cut art at the bottom only.

## Ruling

Owner, 2026-11-07, test review of M27 (PR #1304) on map $01B, via Testing: "I don't want the empty row beyond the bottom of the map even if sprites render off the bottom of the map".

Answering Planning's three questions on #1325:

1. Art past the bottom, cut at the map's edge? "yes, cut off is fine as long as that's not the placement grid location"
2. Top and left? "consistent rule for all sides"
3. A refused-object mark past the bottom, same rule? "yes"

So on every side, art that spills past the map's edge is cut there and grows nothing. A sprite or object whose own placement is off the map still grows the canvas and shows at that cell, as D76 call 2 ruled.

Three build calls under this ruling are not ruled: see [2026-11-07-art-past-edge-proposed-calls.md](2026-11-07-art-past-edge-proposed-calls.md).

## Why

The empty row served no placement: it held only the tail of a sprite whose placement is on the map. Vanilla census (`mapSprites` over 488 maps, develop dfb9d43a, one machine, sprite boxes only): art past the bottom on 4 maps (16 px), the top on 1 (8 px), the left on 9 (8 px), and 0 sprites stored off the map, so on vanilla no sprite grows the canvas. `[EST]` Two corrections from the adversarial review of this branch (not re-measured here): $0F8 also loses a 32 px right-side content band (ring $E2 art), so its far end is now the gutter alone; the per-map pad changes above are for sprite boxes only. Corpus test `OffMapPlacement.corpus.test.ts` re-checks the short sides on those 14 maps, one machine, branch feature/1325-no-empty-row. `[INF]`

## Applies to

`theia/extension/src/browser/off-map-extent.ts` (`contentRects`, `placementRect`) and the `pad` getter in `map-view-widget.tsx`. Narrows D76 call 2 and #1004. The far-end gutter (#1228) is unchanged. Tests: `OffMapExtent.test.ts`, `OffMapPlacement.corpus.test.ts`, `map-sprite-art-past-edge.spec.cjs`.
