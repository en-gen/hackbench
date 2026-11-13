Proposed 2026-11-05 (Delta team)

# The quiet marker is a ring with a clear interior (#1011)

## Question

D99 chose a quiet marker for placed items the game draws nothing for, and Uniform's mockup showed it as an opaque white circle. Acceptance 6 of #1011 says the marker never hides the tile under it. Which look do we build? [PROP]

## Options considered

1. The mockup's opaque circle: reads well, but covers the tile under it (the issue says 12 $C9 shooters on map $126 sit on one Map16 tile; the map data has 16, all on tile $141, read 2026-11-05).
2. A thin neutral ring and small center dot, every other pixel fully transparent, with a one-pixel dark edge so it reads on light and dark art. Hover, click and drag still work over the whole 16 x 16 box, and it draws above the Layer 1 and Layer 2 tiles (priority 3). [PROP]

## Ruling

wording not recorded. 2026-11-05: option 2 is built, to satisfy acceptance 6 of #1011; the owner has not ruled on the look. [PROP]

## Why

Acceptance 6 outranks the mockup's fill. A transparent interior keeps the tile visible, and the dark edge keeps the ring legible on any map art. [INF] from acceptance 6 and the mockup.

## Applies to

The quiet marker on the map view (`map-sprites.ts`, `map-view-model.ts`); not the failure box, not the scroll arrow or purpose tiles (a follow-up under D99 item 5).

## The words for a sprite that ran and drew nothing

The first wording said such a sprite "runs normally, but draws nothing on the map". The app's run draws nothing for it, but a run alone from the level loader's seed cannot tell a sprite that only shows in play, so that claimed more than was checked. The words are now "nothing is drawn for it on the map; it may only show up in play". Shooters, generators and scroll commands keep their own words because the game's loader, not a run, decides them. [PROP]
