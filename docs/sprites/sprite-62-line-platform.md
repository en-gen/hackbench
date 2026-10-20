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
`$65` and `$66` through the `CODE_03C263` JSL then the step JMP, `$67` and `$68` through their draw JSR then the
step JMP. So the map view draws these ids where the line walk left them on their third MAIN (`SpriteRunner.ts`),
as #126 did for the grinder. The three ways in: `LineGrinder` (`11837`, `$67`), `LineRope_Chainsaw` (`11817`, a
33-byte prelude that falls into `LineGrinder`: `$64`-`$66`), and `LineFuzzy_Plats` (`11845`, a bare JMP: `$62`, `$68`).
`$64` is admitted (owner ruling D85 call 1): `InitLineRope` joins `InitLinePlat`'s tail, two `JSR LineFuzzy_Plats`
(`11766-11783`), so its INIT already steps it; the pass-2 rule applies to it all the same. On the vanilla ROM this changes
nothing you can see: for all 12 placements the line step does not move the sprite on pass 0, the rule keeps pass 0, and
each rope is drawn at the same spot as before (and, for the first rope on map 300, the same pixels), on the top edge of a `$92` line tile (runner over maps 15,
221, 298 and 300 in decimal, one machine, 2026-10-17). `$63` stays out: it shares `$62`'s MAIN but no vanilla
placement exercises it. `$62`'s own INIT (`InitLineBrwnPlat`, `11808`) does not step.

For these ids the runner moves to pass 2 only when pass 0 moved the sprite, pass 1 moved it again, and pass 2 draws;
otherwise it keeps pass 0, the generic rule. Only the grinder (`$67`, #126) may stop at pass 1.

## How the gate checks it

Each id is accepted by RUNNING its handler from the ROM's own MAIN pointer (`LineGuided.ts`, #1030) and watching the
calls it makes. Each call target is read from the operand the run reaches and named by a SHA-256 of the routine's
code, one digest per routine (`STOCK`, #1121): the prelude, the platform and rope draws, the `$67` and `$68` draws, the interact, the
chainsaw draw wrapper and the line step. The calls must come in that id's order (`VANILLA_DISPATCH.byId`), ending at
the line step, with no register or SRAM write across every slot and every value of the WRAM cells it reads in slot 3.
A call to a routine that is not one of these is "unverified": the model says why (`lineGateReason`) and the sprite keeps
the old rule. A table a routine reads is outside its span.

## First frame at rest (R16)

`InitLineGuidedSpr` ($01D6ED, 42 bytes, `bank_01.asm:11788-11809`) runs before the sprite's first frame: an even column
subtracts $140 from X, an odd one adds $0F and flips. The map's at-rest picture of `$65`-`$68` is drawn where that INIT
leaves the sprite, taken from the run, not from a constant; the list position is kept as `stored` and outlined while the
sprite is selected, and the Properties panel says how far it moved. On map $00F and $01A all 43 sprites sit 320 px left
or 15 px right of the list position, on its row (vanilla, one machine). A patched `InitLineGuidedSpr` is flagged
unverified (`lineInitReason`) and still runs. The other line-guided ids, and every other sprite, stay on the list position.
