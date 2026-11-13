Question 1: Proposed 2026-11-06 (Overwatch, night shift). Question 2: Ruled 2026-11-07 (Brian, D199). Question 3: Proposed 2026-11-13 (India Team, night shift).

# Reveal search: sprites that drew at rest (#1132, D192)

Queued for Brian as D192. Question 1 is taken as [PROP] on Overwatch's word; not ruled. Question 2 was walked as D199 and ruled.

## Question

#1132 draws a sprite that draws nothing until something happens, found by rerunning its own code (D142). Two cases are not covered by the issue's numbered steps, and the code made a choice for each:

1. A sprite that drew from Mario's real start, is blank under some probe (so it is hidden), and no condition reveals it. Issue step 6 says the marker. What does the map show?
2. For that same kind of sprite (drew at rest, hidden), which of the six conditions are tried?
3. (#1365) When one of those conditions draws the at-rest picture again, is it a reveal?

## Options considered

1A. Keep the real-start picture, drawn whole in the screen door, with the hover "is not always there, and the app could not tell what hides it". No condition is claimed (`none-found`). The marker stays for a sprite that never drew under any run.
1B. Show the marker (reason "unrevealed"), as step 6 reads.

2A. A hidden sprite that drew at rest gets the first three conditions only: Mario at the sprite, just left, just right.
2B. It gets the full ordered list of six.

3a. The same-as-rest rule applies to the three conditions that keep Mario's real position (more-frames, P-switch, ON/OFF). A Mario-position condition that draws the at-rest picture still counts as the reveal.
3b. The rule applies to all six, so a Mario-position reveal whose picture equals the at-rest picture is not counted either.

## Ruling

Question 1: wording not recorded. 2026-11-06: option 1A was taken by Overwatch under night shift as [PROP]; Brian has not ruled it. [INF]

Question 2: Ruled 2026-11-07 by Brian, via Decisions as D199 walking D192 question 2, verbatim: "199B". Option 2B replaces 2A: a hidden sprite that drew at rest is tried against all six conditions (#1365). The issue's acceptance 3 adds that a "reveal" whose picture equals the at-rest picture is reported, not counted.

Question 3: Proposed 2026-11-13 (India Team, night shift, lead call): option 3a is taken as [PROP]. The issue's What paragraph names the three conditions that keep Mario's real position, and for the Mario-position conditions the sprite really is blank with Mario far and drawn with him near, so the condition is information even when the picture matches. Effect of 3b: on the vanilla ROM 29 sprites (the $4D and $4E on maps 10 and 106) would lose "revealed by mario-at-sprite" and be kept in the door as `none-found`, so their tooltips change. The sweep lists them under "Mario-position reveals whose picture equals at rest".

## Why

- 1A differs from issue step 6, which says "marker". It follows the issue's Monty Moles paragraph instead: "All screen door", and "the picture must not depend on where Mario starts", and step 1's "hidden, even if the run from Mario's real start happened to draw it". [EST: the issue text]
- 1B would take away a sprite the game does show at the start: the map would lose a placed sprite's picture for a condition the search could not name, against "never hide placed sprites". [INF: the UI principle in the owner's rulings]
- Vanilla count for 1A is 0 ("kept in the door: 0" in the sweep over 488 maps, 3,239 placed sprites), so the choice reaches hacks only. [EST: one machine, vanilla ROM, one run]
- 2A (replaced): the more-frames, P-switch and ON/OFF reruns keep Mario's real position, so for a sprite that drew from the real start they can repeat the at-rest frame. #1291 took that as [PROP] and stopped at three. [EST: the former `startedDrawn` slice in `RevealSearch.ts`]
- 2B runs those three too, and the same-as-rest rule (tile, offset, palette row, flips and size of the parts) stops a repeat from counting. A synthetic sprite shown only by the P-switch is found; with `slice(0, 3)` restored it goes undetected. [EST: `RevealSearch.test.ts`, red on the old code]
- Vanilla sweep, 488 maps, 3,239 placed sprites, one machine, develop 0a0dc7ba against this branch: revealed 65 and 65, per condition `mario-at-sprite` 65 and 65, kept in the door 0 and 0, hidden 101 and 101; every line of the per-sprite listing is identical. All 42 vanilla sprites that drew at rest and are now hidden are revealed by the first try, so the extra reruns never run on vanilla. The sweep adds two report-only sections: conditions skipped for repeating the at-rest picture (none on vanilla) and Mario-position reveals whose picture equals at rest (29: $4D and $4E on maps 10 and 106; the 13 $A8 sprites on 10a, 117, 1ef differ). [EST: `reveal-sweep.ts`, one run each, vanilla ROM]
- Load cost, the node-side sprite build of the map with the reveal search (`interpRunner`, all the map's sprites), 5 cold processes and 25 warm in-process runs per side, medians, AMD Ryzen 9 5950X, Windows 11, Node 26: the reruns made are identical before and after (maps 10, 106, 10a, 117, 1ef: 337, 247, 490, 118, 116 runs, of which 49, 26, 51, 13, 12 without the search), and the time differences (cold median 623 to 625, 282 to 291, 722 to 722, 142 to 137, 156 to 155 ms) are inside run-to-run noise. [EST: one machine, vanilla ROM; not measured on a hack ROM, where a sprite that draws at rest and hides under a probe may take the extra reruns]
- 3a keeps the 42 vanilla tooltips as they were; 3b would change 29 of them. [EST: the sweep above]

## Evidence scope

Vanilla ROM, one machine (Ryzen 9 5950X), the sweeps of 2026-11-13 rerun on develop 0a0dc7ba and on the #1365 branch (the 2026-11-05 notes file is stale: it predates later changes); the synthetic cart in CI for the behavior of each option. Nothing here was measured on a hack ROM.

## Applies to

`theia/extension/src/node/map-sprites.ts` (the `drewAtRest` branch, `none-found`); `src/rom/sprites/interp/RevealSearch.ts` (`startedDrawn`, `sameAsRest`, `MARIO_POSITIONS`); `docs/rom/reveal-search.md`. If 1B is ruled, one line in `map-sprites.ts`; if 3b, the `i >= MARIO_POSITIONS` test in `RevealSearch.ts`. Promotion to Ruled is the owner's. The issue and its acceptance wording are not edited.
