# Screens and sub-screens

What a screen is in a level, where its two halves meet, and how the ROM
encodes the half. Every claim says whether it was TRACED in SMWDisX or is
INFERENCE. All `file:line` cites are SMWDisX.

## Size per orientation

| Level layout | Screen (tiles) | Screens run   | Sub-screen boundary            |
| ------------ | -------------- | ------------- | ------------------------------ |
| Horizontal   | 16 wide x 27   | left to right | row 16: top 16 rows, bottom 11 |
| Vertical     | 32 wide x 16   | top to bottom | column 16: two 16-wide halves  |

TRACED (SMWDisX, no capture): the screen stride is read from `LoadBlkPtrs`
(`bank_05.asm:730-777`), a per-level-mode pointer into a table of Map16 buffer
addresses, one 3-byte entry per screen. The high-coordinate bit adds `$100`
bytes to the pointer (`bank_05.asm:778-782`), 16 rows of 16 columns. So the
`$200` vertical block is two 16 x 16 pages, one per half. The viewer draws those
two pages SIDE BY SIDE: a vertical screen is 32 wide x 16 tall (`screenTiles`,
`theia/extension/src/node/map-screen.ts:50`). That its 32 x 16 equals "32 rows x
16 cols" transposed is INFERENCE, supported by the nibble swap below and the
right-half comment (`bank_05.asm:781`).

Per level mode (bank_00.asm; "L1" is `Ptrs00BDA8` at 6999-7031, "L2" is
`Ptrs00BDE8` at 7033-7065; tables `DATA_00BAD8` 6727 to `DATA_00BC16` 6847):

| Level modes          | L1 table, stride, base     | L2 table, stride, base  |
| -------------------- | -------------------------- | ----------------------- |
| 0 1 2 C E F 11 1E 1F | `BAD8`, `$1B0`, 16 at `$0` | `BB08`, `$1B0`, `$1B00` |
| 3 4 (L1 vert.)       | `BB38`, `$200`, 14 screens | `BB62`, `$1B0`, `$1B00` |
| 5 6 (L2 vert.)       | `BB92`, `$1B0`             | `BBC2`, `$200`, `$1C00` |
| 7 8 A D              | `BBEC`, `$200`, 28 screens | `BC16`, `$200`, `$1C00` |

"16 screens" and "28 screens" are the effective run-on into the next table (screens
16-31 of a mode-0 L1 read from `BB08` at the same `$1B0` stride).

Where this breaks the port's single-stride model:

- **Modes 3 and 4, screen 14 and up.** `BB38` has 14 entries (`$0` to `$1A00`);
  the next table, `BB62`, starts at `$1B00` with `$1B0` steps, so screen 14 is
  at `$1B00`, not `14 * $200 = $1C00`. No vanilla corpus level uses mode 3 or 4.
- **Modes A and D, L2.** `VerticalTable` bit 1 is clear for both, so the port
  builds the L2 grid horizontal (`$1B0`) while the ROM's L2 table is `BC16`
  (`$200`, `bank_00.asm:7044` and `7047`). Filed as #637.
- **A 16-screen horizontal L1 ends at `$1B00`,** where the L2 buffer begins. A
  run that writes past the last screen (ext `$5F` is one: it writes a fixed
  `$400` bytes, #362) spills into L2 in the ROM; the port clips at the grid edge.
- The `$1B0` and `$200` strides and the `BB38`/`BBEC` mode split are also
  asserted against the vanilla ROM's own tables in
  `test/suite/unit/ExtFill5F.synthetic.test.ts`. Where the grid's three weights come from:
  `theia/extension/src/browser/map-grid.ts`.

## How the ROM encodes the half

TRACED:

- **Objects.** Byte 0 bit 4 is the "high coordinate". When set, the loader adds
  one to the high byte of the Map16 pointer, `$100` bytes = 16 rows. The ASM's
  own comment says "Lower half of horizontal level" and "Right half of vertical
  level" (`bank_05.asm:778-782`, LoadLevelData). A vertical level swaps the X and
  Y nibbles first (`bank_05.asm:654-675`, CODE_0585D8; the swap is skipped for
  extended object 0 with size < 2, `bank_05.asm:655-659`), so the same bit means
  the right half.
- **Sprites.** Byte `YYYYEEsy`; bits `00001101` become the high byte of the
  position (`bank_02.asm:5422-5451`, CODE_02A93C/CODE_02A95B): `y` is a 256 px
  step in Y (horizontal) or in X (vertical, the same code with the axes swapped).
- **Entrances.** Y comes from a 4-bit index into `DATA_05D730` (low) and
  `DATA_05D740` (high byte 0 for indices 0-7, 1 for 8-15); X from a 3-bit index
  into `DATA_05D750`/`DATA_05D758` (high byte 1 for indices 4-7)
  (`bank_05.asm:7044-7053`). Main entrance: `DATA_05F000` Y index,
  `DATA_05F200` X index, screen in `DATA_05F600` (`bank_05.asm:7300-7337`).
  Secondary: `DATA_05FA00` Y index, `DATA_05FC00` screen and X index
  (`bank_05.asm:7117-7161`).
- **Start position** (#339, `src/rom/LevelStart.ts`). The Maps view opens on the map's
  first entrance in play order: the main entrance for an entry map, otherwise the
  entrance of the screen exit the fewest hops from an overworld tile (a primary exit
  enters the destination's main entrance, a secondary exit its `DATA_05F800`
  index, `(submapFlag << 8) | byte`, `bank_05.asm:7103-7118`). Position is the table
  read above, screen = X high byte (horizontal) or Y high byte (vertical). Gate:
  `$05D8B1` must hold the stock `BEQ $F0` (`bank_05.asm:7224`); Lunar Magic JSLs out
  of it, so any other byte is unavailable with a plain-words reason (no address in the UI), never the vanilla
  tables read as if they applied. A map no tile or exit leads to is unavailable too;
  the view then stays at screen 0 and says why. Not covered: the midway entrance,
  a slot reached only through shared map data (same Layer1Ptrs) or the bonus and
  Yoshi Heaven paths. Evidence: vanilla `$109` resolves to screen 6, y 1680; one
  machine, one ROM revision.
- **Orientation decides which high byte survives** (`bank_05.asm:7375-7395`: 7379 tests ScrMode_Layer1Vert, 7382-7383 horizontal, 7386-7387 vertical).
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
