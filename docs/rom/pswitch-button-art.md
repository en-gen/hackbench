# P-switch button art (#574)

The Map16 inspector's switch toggles show the switch itself: the P-switch
sprite for blue and silver, and Map16 tile `$112` for ON/OFF. This page holds
the derivations; `src/rom/PSwitchButtonArt.ts` and `renderPSwitchButtonImages`
in `theia/extension/src/node/map16-decode.ts` keep one-line citations to it.
`src/rom/model/sprites/appearances/PSwitchAppearance.ts` hardcodes the palette
and is not a source for any of this.

## What is read, and from where

All citations are SMWDisX. Every site is gated on its opcodes; every byte in
`PSWITCH_PARTS` is flipped by a synthetic test that expects a refusal.

| Value | Site | Anchor |
| --- | --- | --- |
| StunPow | `CMP #$3E` / `BEQ StunPow`, bank_01.asm:4516-4517 | fixed `$01A1B0` |
| unpressed site | StunPow's `BEQ CODE_01A218`, bank_01.asm:4566 | resolved branch |
| unpressed tile | `LDA #imm` at CODE_01A218+8, bank_01.asm:4582 | resolved |
| SmushedGfxRt | `JSR` at StunPow+12, bank_01.asm:4571 | resolved JSR |
| tile 2 X displacement | `ADC #imm` at SmushedGfxRt+14, bank_01.asm:13899 | resolved |
| Y displacement | `ADC #imm` at SmushedGfxRt+22, bank_01.asm:13903 | resolved |
| pressed tile | `LDA #imm` / `CPX #$3E` at +34, bank_01.asm:13909-13911 | resolved |
| tile 2 x-flip | `ORA #$40` at +73, bank_01.asm:13927 | gated literal |
| tile 1 attribute mask | `AND #imm` at StunPow+21, bank_01.asm:4573-4575 | resolved |
| InitPSwitch | sprite init table entry `$3E`, bank_01.asm:293 | CallSpriteInit's own table |
| PSwitchPal | `LDA PSwitchPal,Y` at InitPSwitch+12, bank_01.asm:674 | resolved |
| SpriteProperties | `LDA.L LevXYPPCCCTtbl,X`, bank_05.asm:539-543 | fixed `$0584F9` |

The dispatch at `$01A1B0` is one comparison in a long, unrelated chain, not a
routine a hack has reason to move on its own. InitPSwitch is resolved through
CallSpriteInit's jump table, `$01844E` on vanilla, so a relocated routine is
still found. `CallSpriteInit` is gated on its `LDA #$08`; a hack that replaces
it may not read the stock table at all, so the read refuses.

## Measured on the 6-ROM corpus

Measured 2026-09-26, one machine, raw bytes:

- The dispatch `C9 3E F0 49`, StunPow's `AND #$FE` tail and PSwitchPal
  `06 02` are byte-identical on 6 of 6.
- CallSpriteInit's `LDA #$08` is replaced by a JSL on 3 of 6 (GPW2 1.1,
  GPW 1.2, Invictus), which refuse.
- The level-mode load at `$0584F9` (`29 1F 8D 25 19 AA BF B7 84 05 85 64`) is
  byte-identical on 6 of 6. LevXYPPCCCTtbl's content differs on GPW2 (it moves
  some modes between `$20` and `$30`), but bits 0-3 are clear in every entry
  on all 6.

## Attribute bits each tile draws with

`SpriteProperties` is written from LevXYPPCCCTtbl by level mode (bank_05.asm:
541-543); the other writers store fixed priority constants (bank_00.asm:
2401-2402, bank_01.asm:2108-2122 and 4218-4226). A level-independent picture
is only honest when every reachable entry agrees on bits 0-3, so the read
covers `AND #mask` + 1 entries and refuses when they disagree.

- Unpressed: `PSwitchPal[i] | SpriteProperties`, through SubSprGfx2Entry1
  (bank_01.asm:4169-4174); `SpriteMisc157C` is 1, so no x-flip.
- Pressed tile 2: `SpriteProperties | SpriteOBJAttribute | $40`
  (bank_01.asm:13924-13928).
- Pressed tile 1: the same without `$40`, then StunPow's `AND #imm`
  (vanilla `$FE`, clearing the name-table bit).

Bit 0 is the OBJ name-table select, the 9th bit of the tile number: clear
reads SP1/SP2, set reads SP3/SP4 (`spriteCharNum`). Bits 1-3 pick one of the
OBJ palettes in CGRAM rows 8-15 (`objAttrToCgramRow`). Vanilla's `$06/$02`
and `$20/$30` leave bit 0 clear everywhere, so vanilla draws from SP1/SP2 on
rows 11 (blue) and 9 (silver).

Bits 6-7 of PSwitchPal (flip) are refused: SubSprGfx2Entry1 ORs the byte in
after skipping its `EOR` (bank_01.asm:4166-4173), so `$46` would flip the
unpressed tile, which this picture does not draw. Vanilla leaves them clear.

## Composition

The unpressed tile is a 16x16 OBJ: tiles N, N+1, N+$10 and N+$11. The PPU
wraps the column within the low nibble and the row within the name table, so
`$4F` pairs with `$40` and `$F2` sits above `$02` (`bigObjTiles`). That is
hardware layout, not ROM data.

The pressed pair sits at the ROM's own displacement inside the fixed 16x16
button frame, so it stays bottom-anchored. Both displacements must keep an
8x8 tile inside the frame (0-8) or the read refuses. When tile 2 overlaps
tile 1 (X below 8), the lower OAM slot wins, as on hardware: tile 2 is drawn
first, then tile 1's non-zero pixels over it.

## ON/OFF: a hack-fragility point

The ON/OFF button is Map16 tile `$112`, the vanilla switch block, off and
with its ON/OFF alternate. A hack can move the ON/OFF block to another tile;
the view reads whatever `$112` is on this ROM and says so when it has no
ON/OFF alternate. Owner-accepted.
