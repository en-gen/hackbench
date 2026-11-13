Proposed 2026-11-13 (foxtrot, #1375, #1376, #1377)

# Koopa first-frame rows wait on the INIT random phase

Queued as D205. Crosses R52 (#1370), which left the grader and the map as they are.

## Question

Nine sprite rows in the `layers_v5` captures grade wrong because the hardware's first frame for a Koopa depends on a random number the map cannot know. What does the project do with them?

## Provenance

| Source | Identifier | As of |
| --- | --- | --- |
| Sprite grader, `layers_v5`, vanilla ROM | develop 0a0dc7ba, one machine, 2026-11-13 | 1955 graded: 1925 exact, 17 close, 13 wrong, 0 empty |
| Per-pass probe of the model | foxtrot, same run | `$1570`, `$1602`, position and `$186C` per pass |
| Verifier probe | seeding `$1570` | 00D, 10A, 12D x3, 11B and 109 turned exact |

## The rows

All nine grade wrong today. `[EST]` grader run above.

| Map | List index | Slot | Id | Hardware | Model |
| --- | --- | --- | --- | --- | --- |
| $00D | 12 | 8 | $02 | tile 226 | tile 224 |
| $10A | 25 | 8 | $02 | tile 226 | tile 224 |
| $12D | 5 | 5 | $02 | tile 226 | tile 224 |
| $12D | 14 | 5 | $02 | tile 226 | tile 224 |
| $12D | 18 | 3 | $02 | tile 226 | tile 224 |
| $11B | 2 | 7 | $03 | tile 200 | tile 202 |
| $109 | 16 | 9 | $0B | 3 pieces (130, 162, 198) | 2 pieces, top tile parked |
| $0C2 | 4 | 4 | $0B | 3 pieces | 2 pieces, top tile parked |
| $122 | 20 | 4 | $0A | 3 pieces | 1 piece graded, wing not drawn |

## Cause

INIT stores a random number as the animation counter.
- `InitStandardSprite` does `JSL GetRand` then `STA SpriteMisc1570,X` (SMWDisX bank_01.asm:844-846). `GetRand` steps the RNG at `$148B/C` twice (bank_01.asm:6092-6122). `[EST]`
- `SetAnimationFrame` shows image `($1570 >> 3) & 1` in `$1602` (bank_01.asm:2089-2097) and runs every frame (called from the shelless Koopa MAIN, bank_01.asm:1691). So the first image is whichever phase the random start gives. `[EST]`
- The hardware's RNG state at INIT depends on every `GetRand` call since power-on. The model starts from the loader's deterministic state (`$1570` is `$93` after INIT on $00D and $0C2, `$80` on $109, one machine). It cannot know the hardware's. `[EST]` for the model values, `[INF]` for the hardware dependence, from the `GetRand` callers.
- On $00D index 12 the graded pass is 3. The model has `$1570` = `$97`, so image 0, tile 224. Hardware shows image 1, tile 226. The model reaches image 1 one pass later. `[EST]`
- The grader accepts a match on any recorded frame, so most Koopa rows pass by chance: over $00-$0D, $02 is 8 exact and 5 wrong, $03 is 4 exact and 1 wrong. `[EST]`

The flying Koopas add a second effect through position.
- A $0B takes its Y speed from `$1570 & $20`, minus 4 or plus 4 (`CODE_018CEA`, bank_01.asm:1900-1906). The random phase therefore moves the sprite, not only its image. `[EST]`
- `Spr0to13Gfx` (bank_01.asm:1748) draws the body 15 pixels up, and its wing routine is called at bank_01.asm:1788. `GetDrawInfoBnk1` (bank_01.asm:4748-4811, called by `SubSprGfx1` at bank_01.asm:3926) sets `$186C` from where the sprite sits against the screen. `CODE_01A3DF` (bank_01.asm:4813-4841) parks the top tile at X=$80 with the size bit set, and `KoopaWingGfxRt` returns without drawing when `$186C` is nonzero (bank_01.asm:4034-4035). `[EST]`
- On $109 the model sprite sits at y=1467 against camera Y 1472, so its top tile is 20 pixels above the screen, flag 1, top tile parked and wing skipped. Hardware sat about 9 pixels lower, flag 0, all three pieces drawn. The model's x (210) equals the hardware's, so the pass is aligned; counting 72 passes from the first real frame instead of 42 moves x to 185, which is wrong. `[EST]`
- The wing and the 9-bit X wrap are the game's own code run faithfully. Nothing in `KoopaWingGfxRt` or the OAM X handling is wrong. `[INF]`
- Vertical-map parsing (#1018) is not involved on $109: the model's x and y at placement equal the sprite list's. `[EST]`
- On $122 the model's draw y is 316, exactly the screen's bottom (camera Y 92 plus 224), so flag 2; hardware's is 315. A one-pixel start-phase difference flips the flag. `[EST]` for the values; `[INF]` that the phase causes it.

## Evidence that the phase is the whole cause

- The verifier seeded `$1570` and re-graded: 00D, 10A, 12D (three rows), 11B and 109 turned exact. `[EST]` verifier probe, one machine.
- $0C2 index 4 and $122 index 4 were not probed. They follow from the same mechanism only. `[INF]`
- November confirmed that $0C2 index 4 and $122 index 4 are not capture mis-credits of a cluster sprite. `[EST]`

## The class

Any option must key on this derivation, never on sprite ids. From the INIT pointer table (bank_01.asm:225-345) `[EST]`:
- Direct `InitStandardSprite`: $00-$08, $0A-$0C, $0F, $10, $11, $13, $14, $1D.
- $09 through `InitGrnBounceKoopa`, which falls into it.
- $28 and $37 through `InitBigBoo`; $38 and $39 through `InitEerie`.
- Reznor, by a `JSL` (`ReznorInit`, bank_03.asm:3174-3182).

Only the sprites that then show `$1570` or `$1602` in their first picture are affected. The set is a consequence of the code and must be recomputed from the ROM, not listed.

## Options considered

1. (A) The grader accepts the other phase only for that class, and only the phases that path can produce. Tile-only is not enough for $0B, whose phase moves it. Planted reds: an out-of-set phase, and a non-class id with a swapped tile.
2. (A2) The grader grades both phases: two runs seeding the `$1570` phase, passing if either matches with the same piece count, so other defects still fail.
3. (B) Record the RNG or `$1570` per sprite in the captures. A harness change; the model still cannot use capture data at runtime.
4. (C) Leave it. The nine rows stay wrong as known RNG rows.

## Ruling

wording not recorded. Recommendation: A2. `[PROP]` Brian rules.

## Why

- A2 keeps a real defect failing: a wrong piece count or wrong shape fails under both phases. `[INF]`
- A needs a phase list per path and is easier to get wrong. B cannot help the map. C leaves nine known-wrong rows in the count. `[INF]`
- Under A2 an exact row means "an acceptable phase", not "the hardware's phase". The sprite doc must say so. `[INF]`

## Re-check

Re-grade these rows after #875 lands. It found that the grader skips the frames between the gate and the anchor for level-start sprites, which moves $122 index 20. `[OPEN]` resolves when the re-grade is run.

## Applies to

`test/suite/support/spriteGrade.ts`, `spriteGrade.captures.test.ts` and its floors, the sprite report. No map code.
