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
