Proposed 2026-11-05 (november-1197)

# Layers 2 and 3 through the far-end gutter (#1197)

## Question

The owner (R41, #1197): "the background layer(s) should extend through this gutter and fade out as the back area color does". Two details were open: does the continuation also cover an off-map content band that sits before the gutter, and what does an object-stream Layer 2, which has no content past the last screen, show?

## Options considered

1. Where the layers run. (a) Gutter only. (b) From the map's far edge through any off-map content band and the gutter.
2. Object-stream Layer 2 past the edge. (a) Only the tiles the stream itself wrote there, usually none. (b) Repeat the map's last screen.

## Ruling

wording not recorded. Proposed 2026-11-05, both `[PROP]`:

1. Option 1b `[PROP]`: the layers run from the map's far edge through the band and the gutter, opaque across the band and fading to clear over the last `farGutter` px. Option 1a would leave a gap of bare back color at the band.
2. Option 2a `[PROP]`: an object-stream Layer 2 shows only what the stream wrote past the last screen, so usually nothing, and only the back color fades there. An image Layer 2 is one fixed plane wrapping every 512 px and continues as the game lays it out. Layer 3 repeats by x as it does on a screen (one copy when it follows the camera); a vertical map has no Layer 3. Option 2b would invent tiles the data does not hold.

## Why

- Pixels the data does not hold must not be drawn. [EST: the project rule never to invent tiles; `rom/map-data-mechanics.md`, section Layer 2 stride and wrap, for the plane size]
- A gap at the band would read as a break in the picture, which no ruling asked for. [INF: from R41's wording]
- Evidence scope: synthetic fixtures (an image plane, an object stream that spills past the edge, one that does not) in the unit tests; no emulator capture of the game's own behavior at the edge, and no owner view of the result yet. [INF]

## Applies to

`drawL2Beyond` and `beyondResult` in `theia/extension/src/node/map-screen.ts`, `loadL2Objects` and `L2Inputs.beyond/plane` in the core, `fadeFarEnd` in `off-map-extent.ts`, the `gutter-layers` canvas in `map-view-widget.tsx`, `architecture/theia-shell.md` section The map strip's pad. Builds on `2026-11-04-map-gutter-far-end-only.md`.
