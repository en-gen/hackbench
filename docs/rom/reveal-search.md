# Hidden sprites: the reveal search (#1132)

A sprite whose code draws only on a condition draws nothing in the at-rest run (D139 D). The map shows it
anyway, drawn where it would appear and through the screen door, with a tooltip that says what shows it. This is
how the app finds out, from the ROM's own code and not from a list of sprite ids.

Evidence scope: derived from SMWDisX and run on the synthetic cart in CI; the vanilla-ROM checks (`RevealC7.corpus.test.ts`,
the Playwright spec) are one machine, and no sample of them is kept in this repo.

## The flow

```mermaid
flowchart TD
  A[at-rest run, real Mario, inputs tracked] -->|refused or erased| Z[no search: marker as today]
  A --> B{drew?}
  B -->|no| H[hidden]
  B -->|yes| K{read a Mario or switch cell?}
  K -->|no| V[visible: no probes]
  K -->|yes| C[rerun with Mario at 10 distances]
  C -->|any run blank| H
  C -->|all drew| V
  H --> S[search, D142 order]
  S --> S1[Mario at the sprite]
  S1 --> S2[just left] --> S3[just right]
  S3 --> S4[more frames, cap 256]
  S4 --> S5[P-switch active] --> S6[ON/OFF flipped]
  S6 -->|drew at rest, none drew a different picture| N[keep the real-start picture in the door, no condition]
  S1 -->|first run that draws wins| P[picture = first drawn frame]
  S6 -->|none drew| M[marker: could not tell what reveals it]
  S6 -->|none drew, a rerun was refused, never drew at rest| R[marker: the interpreter's refusal reason]
```

## What is run

- The first condition, `mario-at-sprite`, puts Mario's position on the sprite's. The tooltip says "gets close to this spot": a mole wakes on a low-byte distance window (bank_01.asm:13342-13346) and a Blargg at about 112 px either side
(bank_03.asm:4071-4076), so "touches" was true only for a sprite that tests Mario's box.
- Every rerun is the same `runOnce` with `atRest`, so the picture's position is the one the at-rest path gives
  (placed spot, parts measured from where the pass ended, or from where it began when the sprite drew there before moving, #1131). The trigger's own movement (the invisible mushroom's
  rise) is therefore not shown. Until #1231 lands, a hidden sprite whose INIT moves it is drawn at the placed spot,
  as every sprite is.
- Mario is fed, never drawn: small ($19 Powerup = 0), in no entrance animation ($71 PlayerAnimation = 0), on foot
  ($72 PlayerInAir = 0), not ducking ($73 PlayerIsDucking = 0), not on Yoshi ($187A PlayerRidingYoshi = 0). The tooltip
  says so.
- Mario's probe position is written after INIT (`SpriteSeed.marioMain`), so INIT sets the facing from the
  level entrance's Mario, as at rest. The left and right conditions never change the facing. A sprite that sets its
  facing in MAIN follows the probe's side; that is a limit, not a claim.
- P-switch is `BluePSwitchTimer` $14AD, ON/OFF is `OnOffSwitch` $14AF (rammap.asm:1665-1667, SMW_U.sym). The
  flipped value is the loaded image's, xor 1.
- A sprite that rewrites its own number ($9E) is followed: the game's sprite loop dispatches whatever number is in
  $9E each frame (CallSpriteMain reads it, `SpriteRunner` runs that loop), so the runner only checks the new number's
  MAIN pointer is code (`resolvePointer`) and refuses with a reason when it is not. Only a live sprite is dispatched, so the check
  is skipped once the sprite's status ($14C8) is 0: a sprite that removes itself and leaves junk in $9E keeps its picture.
- A sprite counts as drawing when its own code draws a tile on any pass, and the served picture is the first such pass,
  even if a child it created drew on an earlier one (`ownPass`).
- Created sprites do not count as drawing (D106A): the probes keep only the OAM entries written while `$15E9` is
  the sprite's own slot (`parts` are own-only in every run since #840; the rest are `companions`).

## Shortcuts and the third outcome

- The at-rest run is tracked (`RunOptions.trackInputs`: cells read before written). A sprite that drew and never read
  Mario's position, his fixed state, `$14AD` or `$14AF` is visible with no probe reruns: every probe would repeat it.
  A blank sprite always goes to the search.
- Every hidden sprite gets all six conditions, one that drew at rest included (Ruled 2026-11-07, D199 B, #1365:
  [the decision](../decisions/2026-11-06-reveal-search-sprites-that-drew-at-rest.md)). The more-frames, P-switch and
  ON/OFF reruns start from the real Mario, so for a sprite that drew at rest one may draw the at-rest picture again.
  That is not a reveal: the result lists it in `sameAsRest` and the search goes on. Compared are the tile, offset,
  palette row, flips and size of the parts (not the OAM slot or priority). Scoped to those three; a Mario-position
  reveal whose picture equals at rest still counts ([PROP], same decision, question 3) and is only reported by the sweep.
- A sprite that drew from the real start, is blank under some probe, and no condition reveals (a repeat of the at-rest picture is not one) keeps its real-start
  picture, drawn in the screen door, with the hover "is not always there, and the app could not tell what hides it".
  No condition is claimed (`none-found`). This differs from the issue's step 6, which says marker; it is proposed, not
  ruled (D192, [the decision](../decisions/2026-11-06-reveal-search-sprites-that-drew-at-rest.md)), and is 0 on vanilla.
  A sprite that never drew under any run is the marker, reason `unrevealed`.
- The door: the sprite's door id carries `WHOLE_DOOR` (ColorMath), so `composeScreen` draws every pixel at the door's
  strength through the existing door map, `doorFlips` counts its swap over all its pixels, and the hover lift (#879)
  makes it solid wherever it is.

## Why ten distances

Montys test only the low byte of Mario's distance: `SubHorizPos` stores `PlayerXPosNow - SpriteXPosLow`
(bank_01.asm:6124-6129; the high-byte subtraction only feeds the sign), and the mole adds $60 and compares with
$C0 (bank_01.asm:13342-13346). The window is 192 of every 256 low-byte values, so the sprite is blank in a 64 wide band
that repeats every 256 px, and a probe at 0 or at 256 sees it drawn. Eight probes spaced $20 apart leave no gap wider
than 32, so the band cannot fall between two; $180 and -$180 (low byte $80) cover a sprite that only needs Mario
near. The test `RevealSearch.test.ts` shows 0 and 256 alone miss it, for sprite positions on both sides of the band.

## Limits

Interpreter limits (dynamic graphics, unmodelled registers) refuse the run as before and a refused run is never
searched. A search rerun the interpreter refuses (for example the sprite becomes a number with no handler) is served as that
refusal, in its own words, when nothing else drew and the sprite did not draw at rest; a sprite that drew at rest keeps its
picture. A sprite no condition shows keeps a marker with the reason `unrevealed`. Revealed sprites are listed by
`npm run sprite:report -- --reveal --map <hex>`, which also lists the sprites that drew at rest and are now hidden.
