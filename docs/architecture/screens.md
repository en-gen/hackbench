# Screens and sub-screens

What a screen is in a level, where its two halves meet, and how the ROM
encodes the half. Every claim says whether it was TRACED in SMWDisX or is
INFERENCE. All `file:line` cites are SMWDisX.

## Size per orientation

| Level layout | Screen (tiles) | Screens run   | Sub-screen boundary            |
| ------------ | -------------- | ------------- | ------------------------------ |
| Horizontal   | 16 wide x 27   | left to right | row 16: top 16 rows, bottom 11 |
| Vertical     | 32 wide x 16   | top to bottom | column 16: two 16-wide halves  |

TRACED: the L1 screen stride is `$1B0` = 27 rows x 16 cols for horizontal
levels and `$200` = 32 rows x 16 cols for vertical ones (`bank_00/MEMO.md:259-260`).
The viewer draws a vertical screen as 32 x 16 (`screenTiles`,
`theia/extension/src/node/map-screen.ts:50`); the ASM agrees on which axis the
halves lie (below). Where the grid's three weights come from:
`theia/extension/src/browser/map-grid.ts`.

## How the ROM encodes the half

TRACED:

- **Objects.** Byte 0 bit 4 is the "high coordinate". When set, the loader adds
  one to the high byte of the Map16 pointer, `$100` bytes = 16 rows. The ASM's
  own comment says "Lower half of horizontal level" and "Right half of vertical
  level" (`bank_05.asm:777-781`, LoadLevelData). A vertical level swaps the X and
  Y nibbles first (`bank_05.asm:654-675`, CODE_0585D8), so the same bit means
  the right half.
- **Sprites.** Byte `YYYYEEsy`; bits `00001101` become the high byte of the
  position (`bank_02.asm:5441-5459`, CODE_02A93C/CODE_02A95B): `y` is a 256 px
  step in Y (horizontal) or in X (vertical, the same code with the axes swapped).
- **Entrances.** Y comes from a 4-bit index into `DATA_05D730` (low) and
  `DATA_05D740` (high byte 0 for indices 0-7, 1 for 8-15); X from a 3-bit index
  into `DATA_05D750`/`DATA_05D758` (high byte 1 for indices 4-7)
  (`bank_05.asm:7044-7053`). Main entrance: `DATA_05F000` Y index,
  `DATA_05F200` X index, screen in `DATA_05F600` (`bank_05.asm:7300-7336`).
  Secondary: `DATA_05FA00` Y index, `DATA_05FC00` screen and X index
  (`bank_05.asm:7117-7160`).
- **Orientation decides which high byte survives** (`bank_05.asm:7435-7451`).
  Horizontal: X high is overwritten with the screen number, so the entrance's Y
  high byte is the top or bottom half. Vertical: Y high is overwritten with the
  screen number, so X high is the left or right half.
- **Screen exits** are keyed by the screen number only, no half
  (`bank_0D.asm:1416-1438`, CODE_0DA512; lookup `bank_05.asm:7095-7100`).

INFERENCE:

- That these halves are what players and tools call a sub-screen. The ASM calls
  them "halves"; the word is not in SMWDisX for level layout.
- That an exit object's `_A & $1F` is a 5-bit screen number, not a Y nibble plus
  a half bit.

NOT TRACED:

- Whether any sprite AI or gameplay routine behaves differently by half. Only
  the data decoding above was read.
- Where the split falls for L2 layouts with the `$200` stride (likely the same
  16-row page, inference).
- The midway entrance, the translevel `$24` room swap (`bank_05.asm:7487-7606`),
  boss rooms that set X directly, and the overworld-override paths.
