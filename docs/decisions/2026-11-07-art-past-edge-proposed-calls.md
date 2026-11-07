Proposed 2026-11-07 (uniform, #1325)

# Calls taken under the art-past-the-edge ruling

## Question

The owner's 2026-11-07 ruling on #1325 ([2026-11-07-art-past-map-edge-grows-no-canvas.md](2026-11-07-art-past-map-edge-grows-no-canvas.md)) says art past a map's edge is cut and a placement off the map grows the canvas. It does not say what "placement" is, what happens to art in the gutter, or what happens to a sprite none of whose art is on the map.

## Options considered

1. Placement: (a) `stored` where a sprite has it, else its anchor, as one 16 x 16 cell. (b) The anchor alone. (c) The art box's top-left.
2. Art that lands in the far-end gutter: (a) still draws, since that canvas exists either way. (b) Cut like the rest.
3. A sprite with no pixel of art on the map (an INIT-shifted sprite whose picture is wholly off the map): (a) its box also counts, so it grows the canvas and stays drawn and selectable. (b) Cut entirely, so it vanishes and cannot be hovered.

## Ruling

wording not recorded. All three were taken as [PROP] by the implementer, 2026-11-07, and are not ruled. Calls 1 and 2 are the issue's own [PROP]s; call 3 is the D52 "never hide a placed sprite" fallback added after the adversarial review.

1. Option a.
2. Option a.
3. Option a. Vanilla has 0 such sprites (sweep of 488 maps, develop dfb9d43a, one machine, boxes only), so no vanilla pad changes. `[EST]`

## Why

1. `stored` is where the map keeps the sprite; the anchor is where it first draws, and they differ only for INIT-shifted sprites.
2. The gutter canvas is there with or without the art.
3. A sprite that cannot be seen or selected cannot be edited, which D52 rules out.

## Applies to

`contentRects` and `placementRect` in `theia/extension/src/browser/off-map-extent.ts`. Tests: `OffMapExtent.test.ts` ("a sprite with no art on the map is never hidden").
