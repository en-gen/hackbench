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
it calls the line step `CODE_01D74D`: `$62` through `CODE_01DAA2` (draw JSR at `12323+`, step JSR 20 lines on),
`$65` and `$66` through the `CODE_03C263` JSL then the step JMP, `$67` and `$68` through their draw JSR then the
step JMP. So the map view draws these ids where the line walk left them on their third MAIN (`SpriteRunner.ts`),
as #126 did for the grinder. The three ways in: `LineGrinder` (`11837`, `$67`), `LineRope_Chainsaw` (`11817`, a
33-byte prelude that falls into `LineGrinder`: `$64`-`$66`), and `LineFuzzy_Plats` (`11845`, a bare JMP: `$62`, `$68`).
`$64` stays out: `InitLineRope` runs the line step twice in INIT (`11766-11786`), so its first MAIN already draws on
the track and all 12 vanilla placements keep the first drawn pass (evidence: runner over the vanilla ROM, one machine).
