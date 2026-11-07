Proposed 2026-11-06 (Overwatch, night shift)

# Reveal search: sprites that drew at rest (#1132, D192)

Queued for Brian as D192. Taken as [PROP] on Overwatch's word; not ruled.

## Question

#1132 draws a sprite that draws nothing until something happens, found by rerunning its own code (D142). Two cases are not covered by the issue's numbered steps, and the code made a choice for each:

1. A sprite that drew from Mario's real start, is blank under some probe (so it is hidden), and no condition reveals it. Issue step 6 says the marker. What does the map show?
2. For that same kind of sprite (drew at rest, hidden), which of the six conditions are tried?

## Options considered

1A. Keep the real-start picture, drawn whole in the screen door, with the hover "is not always there, and the app could not tell what hides it". No condition is claimed (`none-found`). The marker stays for a sprite that never drew under any run.
1B. Show the marker (reason "unrevealed"), as step 6 reads.

2A. A hidden sprite that drew at rest gets the first three conditions only: Mario at the sprite, just left, just right.
2B. It gets the full ordered list of six.

## Ruling

wording not recorded. 2026-11-06: options 1A and 2A were taken by Overwatch under night shift as [PROP]; Brian has not ruled them. [INF]

## Why

- 1A differs from issue step 6, which says "marker". It follows the issue's Monty Moles paragraph instead: "All screen door", and "the picture must not depend on where Mario starts", and step 1's "hidden, even if the run from Mario's real start happened to draw it". [EST: the issue text]
- 1B would take away a sprite the game does show at the start: the map would lose a placed sprite's picture for a condition the search could not name, against "never hide placed sprites". [INF: the UI principle in the owner's rulings]
- Vanilla count for 1A is 0 ("kept in the door: 0" in the sweep over 488 maps, 3,239 placed sprites), so the choice reaches hacks only. [EST: one machine, vanilla ROM, one run]
- 2A: the more-frames, P-switch and ON/OFF reruns keep Mario's real position, so for a sprite that drew from the real start they repeat the at-rest frame and would call that a reveal. [EST: `RevealSearch.ts`, the `startedDrawn` slice]
- 2B would run three more reruns, the longest 256 passes, for each of the 42 sprites that were solid at rest and are now in the door. The load-time cost has not been measured. [UNKNOWN: not measured]

## Evidence scope

Vanilla ROM, one machine, the sweep of 2026-11-05 (`1132-sweep-vanilla.txt`); the synthetic cart in CI for the behavior of each option. Nothing here was measured on a hack ROM.

## Applies to

`theia/extension/src/node/map-sprites.ts` (the `drewAtRest` branch, `none-found`); `src/rom/sprites/interp/RevealSearch.ts` (`startedDrawn`, `tries.slice(0, 3)`); `docs/rom/reveal-search.md`. If 1B is ruled, one line in `map-sprites.ts`; if 2B, one line in `RevealSearch.ts`. Promotion to Ruled is the owner's. The issue and its acceptance wording are not edited.
