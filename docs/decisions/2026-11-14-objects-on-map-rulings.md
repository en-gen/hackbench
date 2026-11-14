Proposed 2026-11-14 (echo, #1237)

# Objects on a map: the calls made while building round 1

## Question

#1237 (find saved Objects on a Layer 1 map and select them and their edge segments, read-only) left the method and several limits to the builder. Eight calls were made on night shift and none has the owner's word yet. The method, the ties and the limits are in [objects-on-map.md](../architecture/objects-on-map.md); this record lists the calls, so the owner can overrule any.

## Ruling

wording not recorded. 2026-11-14, night shift: each call below as written. `[INF]` Eight calls, each with what was decided, why, and where it is pinned.

### 1. A map with a non-stock Map16 loader says Objects cannot be found (P1)

- Decided: `objectsRefusal` refuses in plain words unless the Map16 table holds the stock 512 tiles and the byte at `$05803B` is the unhooked `CMP`. That byte is a proxy for the Lunar Magic loader hijack, not a read of any Map16 loader. It holds until the hacks milestone traces the loader.
- Why: matching on tiles a hack gave one map of its own would be wrong, and a refusal in words is better than a wrong match (#1234 round 1 call 5). On the corpus it refuses all five hack ROMs and accepts both vanilla ROMs.
- Pinned: `ObjectsRefusal.synthetic.test.ts` (synthetic carts), `ObjectRecognize.corpus.test.ts` (Invictus), `MapObjects.test.ts`.

### 2. No Properties subject in round 1 (P2)

- Decided: selecting an Object publishes nothing to the Properties panel. The hover tooltip names the Object.
- Why: round 1 is read-only and an Object has no properties to edit yet; the name is the only fact worth showing.
- Pinned: `map-objects.spec.cjs` (Playwright; hover and selection assertions), `ObjectSelection.test.ts`.

### 3. Stored pieces group by edge contact only (P3)

- Decided: two pieces link where 4-adjacent cells have an edge tile between them. Overlap is not contact, fill beside fill proves nothing, and a link counts only when its contact covers half of the smaller piece. Links are taken best first.
- Why: on `$103` the ground fill piece sits under every platform interior with the same tiles; counting fill contact glues the four platforms to it, and counting overlap merges stacked platforms.
- Pinned: `ObjectRecognize.test.ts` (four stacked platforms in 60 piece orders), `ObjectRecognize.break.test.ts` (fill beside fill), `ObjectRecognize.corpus.test.ts` (`$103` whole map, nine Objects).

### 4. The grab zone is 8 px either side of the outline

- Decided: a segment answers within `EDGE_BAND` (half a tile, 8 px) of the outline on either side, which is the edge tile's own middle line on the inside and the same width outside. Further in is the Object. It is one named constant, to be tuned in use.
- Why: the owner's words were "about the outer half of an edge tile" and "outside the line the pointer gets the edge, and inside it gets the Object".
- Pinned: `ObjectSelection.test.ts`, `map-objects.spec.cjs`.

### 5. A breaking post-pass decides what a disagreeing tile breaks (Rule R)

- Decided: a group that passes the rule and shows a cell is a candidate. A visible edge tile with all four neighbors in a candidate's shape breaks the Object directly behind it, unless its owner is a whole Object with fill of its own. A group that fails the rule yields nothing and is not offered back as fragments.
- Why: #1234 says a disagreeing tile blocks the match, and a later piece is the only way a tile changes. The "whole Object in front" exception keeps `$103`'s stacked platforms (one platform's right edge lies wholly inside another's body).
- Pinned: `ObjectRecognize.break.test.ts` (breaking, mending, N-case sweeps), `ObjectRecognize.limits.test.ts`.

### 6. A run of slope tiles at one angle is one monotone segment

- Decided: consecutive runs of one slope class that alternate between two directions are one `slope` segment, a single tile included. It never reverses in x or y and never takes the boundary of a non-slope cell.
- Why: #1234 round 1 call 4 says a run of slope tiles at one angle is one segment. The class is the rise over 15 pixels from the game's own slope tables, not a typed list.
- Pinned: `ObjectOutline.test.ts` (staircases of 1 to 7 tiles, floor, seam), `map-objects.spec.cjs` (slope probe).

### 7. Side-by-side Objects stay two; the refusal and its edges

- Decided: a link is refused when it is only an edge beside an edge, side by side (`side * 2 >= w`), between two groups that each close (some row has an edge, then fill, then an edge, so a closing row needs 3 columns). A ledge and the continuation of its walls merge; one ledge above another merges at 1 and 2 rows; a ledge extended sideways merges; a cap or slope merges with its hill; an Object 2 columns wide (a pipe) merges.
- Why: two whole Objects that touch side by side must stay two (#1234 round 1 call 2), and a ledge drawn in two parts, a hill and its slope piece, and a sideways extension must not be split. The two shapes that pin the `>=` threshold are an L contact; the narrow-Object counts are stated limits.
- Pinned: `ObjectRecognize.break.test.ts` (touching sweeps, continuation, extension, one-piece, threshold), `ObjectRecognize.limits.test.ts` (narrow Objects), `ObjectRecognize.corpus.test.ts` (`$118`, `$116`, `$12D`, totals).

### 8. Acceptance 4 is graded on single Objects; layered edits are a stated limit

- Decided: a visible tile that disagrees with an Object stops its match, and undoing restores it, for an edit inside a single Object. An edit inside layered Objects (a lone edge tile dropped into a stack of platforms, or a piece that holds fill but changes one tile) is a stated limit with exact counts. The owner's ruling on that scope is D210, reference only here.
- Why: the tile's own grouping cannot tell it from an edge of the neighbor it touches (94 of 142 stack cells stay alone). An attempt to fix it, R10 (an edge-only piece wholly inside another group's shape links to nothing), fragments `$103`'s four platforms (nine Objects 40, 24, 90, 60 become 4, 4, 4, 8; 20 tests red), so it is parked, not merged.
- Pinned: `ObjectRecognize.limits.test.ts` (exact counts); the limits section of [objects-on-map.md](../architecture/objects-on-map.md); the parked branch `parked/1237-r10-edge-only-no-link` (local only, commit `6533c006`).

## Why

Evidence scope: synthetic maps built with `stamp` (sweeps over sizes and piece orders) and vanilla `$101` to `$13B` under three probe definitions, one machine; the Playwright spec was run by the verifier, not by the builder.

## Applies to

`src/rom/objects/` (`Recognize.ts`, `Outline.ts`, `Describe.ts`, `ObjectInputs.ts`), `src/project/ObjectDefinitionsStandIn.ts`, `theia/extension/src/node/map-objects.ts`, `theia/extension/src/browser/object-overlay.tsx` and `object-selection.ts`, `theia/browser-app/test/map-objects.spec.cjs`, [objects-on-map.md](../architecture/objects-on-map.md), #1237, #1234.