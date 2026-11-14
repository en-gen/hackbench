Question 1: Proposed 2026-11-06 (Overwatch, night shift); Decision 198 ruled 2026-11-07 that Brian reviews a manifest first (#1363). Question 2: Ruled 2026-11-07 (Brian), D192 question 2, walked as Decision 199, ruled 199B. Question 3: Proposed 2026-11-13 (India Team, night shift), queue item D207; no [PROP] taken.

# Reveal search: sprites that drew at rest (#1132, D192)

Queued for Brian as D192. Question 1 is taken as [PROP] on Overwatch's word; not ruled. Question 2 was walked as Decision 199 and ruled 199B. Question 3 came up building #1365 and is queue item D207.

## Question

#1132 draws a sprite that draws nothing until something happens, found by rerunning its own code (D142). Two cases are not covered by the issue's numbered steps, and the code made a choice for each:

1. A sprite that drew from Mario's real start, is blank under some probe (so it is hidden), and no condition reveals it. Issue step 6 says the marker. What does the map show?
2. For that same kind of sprite (drew at rest, hidden), which of the six conditions are tried?
3. (#1365, D207) Acceptance 3 says a "reveal" whose picture equals the at-rest picture is not counted. For a Mario-position condition (Mario at, left of, right of the sprite), should that rule apply too?

## Options considered

1A. Keep the real-start picture, drawn whole in the screen door, with the hover "is not always there, and the app could not tell what hides it". No condition is claimed (`none-found`). The marker stays for a sprite that never drew under any run.
1B. Show the marker (reason "unrevealed"), as step 6 reads.

2A. A hidden sprite that drew at rest gets the first three conditions only: Mario at the sprite, just left, just right.
2B. It gets the full ordered list of six.

3A. A Mario-position condition that draws the at-rest picture still counts as the reveal (the rule applies only to more frames, P-switch and ON/OFF).
3B. The rule applies to all six: a Mario-position condition that draws the at-rest picture is not a reveal. Built, as acceptance 3 reads.
3C. As 3B, but the tooltip for such a sprite does not claim the app could not tell what hides it (it says only that the sprite is not always there).

## Ruling

Question 1: Walked as Decision 198 (2026-11-07; A recommended). Ruled 2026-11-07 (Brian): "D198 - create a manifest of sprites like this and the map(s) they appear on and let me review them so I can decide on how best to handle them". That is neither option: a list of every sprite that draws when the map opens, then hides, and that the reveal search cannot bring back, with the maps each is on, for Brian to review before he decides. It was filed as #1363 (measure only; it waits for the hacks milestone). PR #1291 is merged with 1A as built, and 1A stands meanwhile. Question 1 stays open for his ruling after the review.

Question 2: D192 question 2, walked as Decision 199, ruled 199B (2026-11-07, Brian, via Decisions). Verbatim: "199B" (B: run the full list of six reveal conditions for a hidden sprite that drew at rest). Option 2B replaces 2A (#1365). Acceptance 3 of #1365 adds that a "reveal" whose picture equals the at-rest picture is reported, not counted.

Question 3: Proposed 2026-11-13 (India Team, night shift), queue item D207; not ruled, no [PROP] taken. The conformant version, 3B, is built, so the open question for the owner is whether a Mario-position reveal with the at-rest picture should still count (3A) or be worded differently (3C). Effect of 3B on the vanilla ROM: the 29 $4D and $4E Monty Moles on maps 10 (25) and 106 (4) draw the same picture wherever Mario stands, so none of the six conditions is a reveal and they end as `none-found`: their tooltip goes from "<name>: appears when Mario gets close to this spot (small Mario, on foot)" to "<name>: is not always there, and the app could not tell what hides it", and the picture stays in the screen door. The 13 $A8 sprites (10a, 117, 1ef) are unchanged.

## Why

- 1A differs from issue step 6, which says "marker". It follows the issue's Monty Moles paragraph instead: "All screen door", and "the picture must not depend on where Mario starts", and step 1's "hidden, even if the run from Mario's real start happened to draw it". [EST: the issue text]
- 1B would take away a sprite the game does show at the start: the map would lose a placed sprite's picture for a condition the search could not name, against "never hide placed sprites". [INF: the UI principle in the owner's rulings]
- Vanilla count for 1A is 0 ("kept in the door: 0" in the sweep over 488 maps, 3,239 placed sprites), so the choice reaches hacks only. [EST: one machine, vanilla ROM, one run]
- 2A (replaced): the more-frames, P-switch and ON/OFF reruns keep Mario's real position, so for a sprite that drew from the real start they can repeat the at-rest frame. #1291 took that as [PROP] and stopped at three. [EST: the former `startedDrawn` slice in `RevealSearch.ts`]
- 2B runs those three too, and acceptance 3 stops a repeat of the at-rest picture from counting. What is compared is what the map draws from the pass it takes the picture from: every part including companions, with tile, offset, palette row, priority, flips, size and door tag, then the neighbor children it drew, the pass's upload list, the NET colors CGRAM holds at the run's last pass (the last write to each color wins; the write history is not compared, since a run that writes a color every pass has a longer one) and the graphics slots it pointed at (`pictureKey`); the OAM slot is left out, since the same pieces in other slots are the same picture and priority is compared. A synthetic sprite shown only by the P-switch is found; with `slice(0, 3)` restored it goes undetected. [EST: `RevealSearch.test.ts`, red on the old code]
- Phase effect: a palette-cycling sprite's 256 pass rerun can end on other colors than the 64 pass at-rest run, so it can report a color-only `more-frames` reveal. That is what the map would draw. Hack-only; 0 on vanilla (no vanilla sprite is hidden and reaches more-frames). [EST: sweep below; one machine]
- A sprite that drew at rest and is revealed only by a later condition (more frames, P-switch, ON/OFF) now shows the revealed picture in the door, with that condition's tooltip, instead of its at-rest picture marked `none-found`. 0 on vanilla. [EST: sweep below]
- The rope is not compared: its at-rest run is placed in the slot the loader gives it and its reruns run in slot 0, so their pictures differ in length and could not be equal. The 12 vanilla ropes are none of them hidden, so the search never reaches them on vanilla. [EST: the sweep listing, `RevealSearch.ts` `comparable`]
- Vanilla sweep (a smoke test, not coverage evidence), 488 maps, 3,239 placed sprites, one machine, develop 0a0dc7ba against this branch: revealed 65 to 36 (`mario-at-sprite` 65 to 36, the other five conditions 0 and 0), kept in the door 0 to 29, hidden 101 and 101, markers unchanged. The 42 vanilla sprites that drew at rest and are now hidden were all revealed by the first try before; now the 29 moles are not and the 13 $A8 sprites are. Conditions skipped for repeating the at-rest picture: each of the six 29 times (the 29 moles). [EST: `reveal-sweep.ts`, one run each, vanilla ROM]
- Load cost of map open, the node-side handling of the map view's sprite request (`mapSprites`, the body of the RPC the widget calls on open; fresh `L1ModelCache` for cold, a new copy of the working-copy bytes per warm run), Ryzen 9 5950X, Windows 11, Node 26, 5 cold processes and 25 warm runs per side, medians:

  | Map | Interpreter runs before / after | Cold ms before / after | Warm ms before / after |
  | --- | --- | --- | --- |
  | 10 | 337 / 462 | 1789 / 4173 | 1635 / 3700 |
  | 106 | 247 / 267 | 786 / 1218 | 813 / 1203 |
  | 10a | 490 / 490 | 1929 / 2006 | 1820 / 1804 |
  | 117 | 118 / 118 | 470 / 500 | 460 / 469 |
  | 1ef | 116 / 116 | 547 / 547 | 517 / 490 |

  The time follows the reruns: 25 moles on map 10 and 4 on map 106 take 5 more reruns each (the six conditions where one found it before), the more-frames one running 256 passes. Maps 10a, 117, 1ef run the same reruns and their differences are noise. The map model build is 110 to 170 ms of each total, so the sprite build is nearly all of it. The cost falls on every open of a map not already in the reply cache (a reply is kept per working-copy bytes, 8 maps). [EST: one machine, vanilla ROM, other teams running on it; a hack ROM was not measured]
- 3A keeps the 29 vanilla tooltips as they were and avoids those 145 extra reruns (125 on map 10, 20 on 106), since the search stops at the first Mario position; 3B changes the 29 tooltips and pays them; 3C changes them to a milder wording. [EST: the sweep and table above]

## Evidence scope

Vanilla ROM, one machine (Ryzen 9 5950X), the sweeps and map-open timings of 2026-11-13 rerun on develop 0a0dc7ba (a throwaway worktree) and on the #1365 branch (the 2026-11-05 notes file is stale: it predates later changes); the synthetic cart in CI for the behavior of each option. The sweep is a smoke test. Nothing here was measured on a hack ROM.

## Applies to

`theia/extension/src/node/map-sprites.ts` (the `drewAtRest` branch, `none-found`); `src/rom/sprites/interp/RevealSearch.ts` (`startedDrawn`, `sameAsRest`, `pictureKey`, `comparable`); `docs/rom/reveal-search.md`. If 1B is ruled, one line in `map-sprites.ts`; if 3A, a Mario-position condition skips the `sameAsRest` branch in `RevealSearch.ts`; if 3C, one string in `map-sprites.ts` (`REVEAL_TEXT`) and the branch that sets it. Promotion to Ruled is the owner's. The issue and its acceptance wording are not edited.
