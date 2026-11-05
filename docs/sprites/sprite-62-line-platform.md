# $62 brown platform (line-guided): draw offset

Moved from the deleted `LineBrownPlatBehavior` (#409). `xShiftPx` in
`LineBrownPlatAppearance.ts` implements it.

## Direction from the spawn column

`InitLinePlat` (`bank_01.asm:11774`) reads bit 4 of `SpriteXPosLow`, flips
it, and stores the result in `SpriteMisc1602`:

| Spawn column | Bit 4 | `SpriteMisc1602` | Direction |
| ------------ | ----- | ---------------- | --------- |
| even         | clear | `$10`            | forward   |
| odd          | set   | `$00`            | reverse   |

HackBench resolves the direction when the map loads
(`resolveLineGuideAttachment`) and keeps it in `behavior.lineGuide.direction`.

## Shift before drawing

`CODE_01DAA2` (`bank_01.asm:12323`) shifts the sprite's X left before the
three-tile draw: by `$28` (40 px) when `SpriteMisc1602` is `$10` (forward),
and by `$18` (24 px) when it is `$00` (reverse). Y moves up by `$08`. The
appearance applies the same shift at render time, so the parts are stored in
platform-local coordinates.

## Draw, then line step (#792)

Every line-guided id ends in the one dispatch `CODE_01D9A7` (`bank_01.asm:12182-12204`), and each arm draws before
it calls the line step `CODE_01D74D`: `$62` through `CODE_01DAA2` (shift, draw JSR `CODE_01B2DF` at `12347`, restore, step JSR at `12358`; arm `12323-12358`),
`$65` and `$66` through the interact call, the `CODE_03C263` JSL, then the step JMP, `$67` and `$68` through their draw JSR,
the interact, then the step JMP. So play and simulate place these ids where the line walk left them on their third MAIN
(`SpriteRunner.ts`), as #126 did for the grinder; the map's picture at rest takes the first frame on the line instead (D156, below), which replaced the earlier D91 pick of the list position for these ids. The three ways in: `LineGrinder` (`11837`, `$67`), `LineRope_Chainsaw` (`11817`, a
prelude that falls into `LineGrinder`: `$64`-`$66`), and `LineFuzzy_Plats` (`11845`, a bare JMP: `$62`, `$68`).
`$64` is admitted (owner ruling D85 call 1): `InitLineRope` joins `InitLinePlat`'s tail, two `JSR LineFuzzy_Plats`
(`11766-11783`), so its INIT already steps it. On the vanilla ROM all 12 placements already sit on their line: the line
step does not move the sprite on pass 0, the rule keeps pass 0, and each rope is drawn at the same spot as before, on the
top edge of a `$92` line tile (maps 15, 221, 298 and 300 in decimal, one machine, 2026-10-20). `$63` stays out: it shares
`$62`'s MAIN but no vanilla placement exercises it. `$62`'s own INIT (`InitLineBrwnPlat`, `11808`) does not step.

For these ids the runner moves to pass 2 only when pass 0 moved the sprite, pass 1 moved it again, and pass 2 draws;
otherwise it keeps pass 0, the generic rule. Only the grinder (`$67`, #126) may stop at pass 1.

## How the gate checks it

Each id is accepted by RUNNING its handler from the ROM's own MAIN pointer (`LineGuided.ts`, #1030) and watching the
calls it makes. Each call target is read from the operand the run reaches. A draw, the prelude and the line step are named
by a SHA-256 of the routine's code, one digest per routine (`STOCK`, #1121): the prelude, the platform and rope draws, the
`$67` and `$68` draws, the chainsaw draw and the line step, 41 to 164 bytes each. The FastROM bit of each long operand's bank
byte is folded first, so a ROM moved to the `$80` banks is the same routine. The spans hold the code and any table inside
them: the line step's holds the pointer table after its call, and the `$67` draw's branch tail `CODE_01DBD0` (4 bytes)
lies outside its span, so it is not hashed. `MarioSprInteractRt` is not hashed: its slot takes any callee that
is not one of these. The calls must come in that id's order (`VANILLA_DISPATCH.byId`), ending at the line step, with no
register or SRAM write across every slot and every value of the WRAM cells it reads in slot 3. A call to anything else
is "unverified": the model says why (`lineGateReason`) and the sprite keeps the old rule.

## First frame at rest (R16, refined by D156)

**D156 (2026-10-29):** the picture at rest is where the game first has the sprite ON ITS LINE: the pass after `SpriteTableC2,X` ($00C2) is 1 (the lock, `bank_01.asm:12116-12118`) with the lock timer `SpriteMisc1540,X` run out (`LineAppearance.ts` `onLinePass`). The draw comes before the line step (`bank_01.asm:12204-12215`), so each frame is drawn where the frame before ended. The lock itself leaves it on the probe corner. A sprite whose INIT moved it and that starts behind the scroll in every spawn the loader allows (`LoadSprFromLevel`, `bank_02.asm:5217-5281`; map load, `bank_02.asm:5880-5914`) stays on its stored tile, and the Properties note says "never appears in play": the 7 even-column `$65` on map $0f and the 3 even-column `$67` on map $1a. See [the decision](../decisions/2026-10-29-line-guided-first-frame-on-line.md). The R16 text below describes the INIT spot, now `initAt`.


`InitLineGuidedSpr` ($01D6ED, 42 bytes, `bank_01.asm:11788-11811`) runs before the sprite's first frame: an even column
subtracts $140 from X, an odd one adds $0F and flips. The map's at-rest picture of an admitted line-guided sprite is
drawn where the game first draws it, taken from the run: no id list and no constant decide it. That is where its start-up
code left it, or one step on if the first pass that draws comes after a step. A sprite that is not moved before its first
draw stays on its tile. The map's tile for it is kept as `stored` and outlined while the sprite is selected, and
the Properties panel says how far it moved. On the vanilla ROM all 90 `$65`-`$68` placements sit 320 px left or 15 px
right of their tile, on its row, and none of the 6 `$62` or 12 `$64` do (7 maps, one machine, 2026-10-20). A sprite drawn away from its
tile whose INIT is not one of the two stock line-guided INITs (`InitLineGuidedSpr`, and `InitLineRope` with the
`InitLinePlat` tail it falls into) is flagged unverified (`lineInitReason`), whatever its id, and still runs. The note says how
much of the move was start-up code and how much its first step.

## The rope ($64) at its in-game length (#1230, D152 / Decision 103 E)

The draw uses 5 tiles, or 9 when the slot it runs in is 6 or higher and the sprite memory setting is not 0 (`bank_01.asm:12583-12589`; the same test sizes the OAM at 12624-12628). The level loader picks the slot (`bank_02.asm:5376-5405`): the top slot of `SpriteSlotMax[setting]`, searching down to `SpriteSlotStart[setting]` (not tested itself; `$FF` runs through slot 0), with `ReservedSprite1/2` ids taking their own ranges. `$64` is `ReservedSprite2` on setting 1 only, and only when bit 4 of the spawn coordinate on the scroll axis is set (`CMP #$64`, `AND #$10`, 5389-5393): an odd 16 px column in a horizontal map, an odd row in a vertical one (`$00` is Layer1X or Layer1Y plus the offset, 5217-5240). That odd rope searches from `SpriteSlotMax2` (7) down; an even one searches 5 to 0.

Map view: `SlotPick.ts` fingerprints the 62-byte pick (one SHA-256, none masked), reads the table addresses from its operands, and walks the same search; `RopeLength.ts` runs the rope's own draw in the slot the loader gives it, so the ROM's branch yields the tile count and no length is written in HackBench. Where ordinary sprites can take the same slots (settings 2 to 7 and the like), the draw is run in the top slot and in the last slot of the range; the parts only the top run drew are tagged `door` (shown in the screen door once #1132's door is wired). Setting 0 draws 5 tiles in every slot. A loader that is not the fingerprinted one, or a setting past the tables, keeps slot 0 (5 tiles) and the Properties tooltip says so.

Assumption, not modelled: slots 6 and 7 on setting 1 are reachable only by `$5F` and odd `$64`, so an odd rope is long unless three or more of those are alive at once; no earlier-sprite occupancy is simulated. The slot does not move the first frame: the line walk's positions are the same in slot 5 and 7 on map `$00F` (corpus test); only the motor tile, which the draw takes from the slot and `EffFrame` (`bank_01.asm:12574-12582`), can differ.

Evidence: Mesen 2 on map `$00F`, one machine, 4 of 4 runs: columns 205 and 241 in slot 7 (long), columns 164, 186, 210, 216 short. Maps `$0DD`, `$12A` and `$12C` are uncaptured; the corpus test pins what the rule draws there.
