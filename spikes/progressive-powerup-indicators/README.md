# Progressive powerup block indicators

Issue #607. Builds on the D4 pick of [block-content-indicators](../block-content-indicators/README.md)
(#566). Status: mockup for the owner to review; spike code, not product code.

## Result

Chosen design: **DH** (2026-10-05, owner): a diagonal split from top-left to
bottom-right, hard split with no line, mushroom in the bottom-left triangle
and the flower or feather in the top-right. The same split is used in the D4
quadrant at rest and in the full-block hover state. Progression reads left to
right and bottom to top.

Why the others lost:

- The thick lines (the earlier W2/W3 weights) were too heavy and obscured the powerups.
- The outlined and black-line variants (HO, HL, HD, HD2, VO, VD, VD2, DO) added a divider the hard split does not need.
- The horizontal and vertical splits (H*, V*) were not chosen over the diagonal.

The variant list below stays as the record; the page still generates all of them.

Question: some blocks hold a powerup that depends on Mario's state (a flower
or feather that becomes a mushroom when he is small). How does the D4
indicator show that?

## Rebuild the mockup

Prerequisites as in the #605 spike (`npm ci`, vanilla ROM found through
`test/suite/support/corpus.ts`).

```bash
npx tsx spikes/progressive-powerup-indicators/probe.ts   # finds the blocks in map $003, extracts graphics to assets.json
node spikes/progressive-powerup-indicators/gen.cjs       # builds mockup.html
```

Both files land here and are gitignored (they embed ROM graphics). Both
scripts take optional path arguments, as in #605. The probe imports the PNG
and item-sprite helpers from `../block-content-indicators/lib.ts` (extracted
from that spike's `probe.ts` unchanged, which now imports them too).

## Variants (all D4: half-scale in the bottom-right quadrant, full block on hover)

Both items share one indicator, split in two. The powerup (flower or feather)
is always the upper part and the mushroom always the lower part, in every
variant. Owner rulings (coordinator messages, 2026-10-05): the divider is
measured in SCREEN pixels, constant at every zoom and in the hover state
(an earlier version scaled it with zoom and swallowed the items); the lead
family is a horizontal split, clipped at the vertical midpoint.

1. HO: horizontal; 1px white line, 1px black border each side (3px in all).
2. HL: horizontal; 1px white line, 1px black border on the mushroom side only.
3. HD: horizontal; 1px black line.
4. HD2: horizontal; 2px black line.
5. HH: horizontal; hard split, no line.
6. VO: vertical split at the horizontal midpoint (mushroom left, powerup
   right); 1px white line, 1px black border each side.
7. VD: vertical; 1px black line.
8. VD2: vertical; 2px black line.
9. VH: vertical; hard split, no line.
10. DO: diagonal top-left to bottom-right (powerup top-right, mushroom
   bottom-left); 1px white line, 1px black border each side.
11. DH: diagonal top-left to bottom-right; hard split, no line.

Owner rule for every variant: progression reads left to right and bottom to
top. The mushroom is always the left or bottom item and the powerup always the
right or top item (diagonal: mushroom bottom-left, powerup top-right).

A checkbox on the page switches the stage to a dark backdrop.

Each variant shows map $003 (Top Secret Area) at 1x, 2x and 3x with its real
progressive blocks and three plain D4 blocks added in free cells for
comparison, then the quadrant at rest and the forced hover state at 6x. The
page also holds a sample Properties "Contains" row.

## The ROM rule

All tile ids below are Map16 ids; the game's `Map16TileNumber` is the low
byte and only a nonzero high byte (page 1, ids `$1xx`) reaches the block-hit
code (`bank_01.asm:2617-2623`). Evidence: SMWDisX reading plus the table bytes
read from the vanilla ROM by the probe; not run in an emulator.

1. Every hit, by Mario or by a sprite, reaches `CODE_00F160`: Mario via
   `CODE_00F127` (`bank_00.asm:12193`, `12263`), sprites via
   `bank_01.asm:3051`, `bank_01.asm:3545`, `bank_02.asm:2864`. One rule for all.
2. `CODE_00F160` (`bank_00.asm:12827-12846`) turns the low byte into a table
   index `low - $11`. Below `$1D` that is ids `$111-$12D`; above it only low
   `$59`/`$5A` pass (ids `$159`, `$15A`), in a tileset whose `DATA_00A625`
   entry has bits 0-1 clear. Indices `$1D-$21` are never reached, so ids
   `$12E-$132` (which the table has bytes for) are dead data.
3. `DATA_00F080` (`bank_00.asm:12751`), indexed that way, holds the content
   byte (`CODE_00F17F`, `bank_00.asm:12859`). Content = byte >> 1, an index
   into `SpriteInBlock` (`bank_02.asm:1078`): 1 `$74` mushroom, 2 `$75` fire
   flower, 3 `$76` star, 4 `$77` feather, 5 `$78` 1-Up. Bit 0 is the
   progressive flag.
4. The substitution is `CODE_00F1BA` (`bank_00.asm:12877-12885`): `LSR A`
   puts bit 0 in carry; if set and the content is not 3, `LDY Powerup` (`$19`:
   0 small, 1 big, `rammap.asm:140-146`) and a small Mario (0) gets content 1,
   the mushroom. Big, cape and fire Mario get the table's item unchanged. Mario
   has no other test: a fire-flower block gives a flower to cape Mario too.
5. A byte with bit 7 set takes its content from `DATA_00F100`
   (`bank_00.asm:12778`) by block column instead (`bank_00.asm:12868-12876`):
   index = (bit 0 of the byte << 4) | (X pixel >> 4), a 16-column pattern per
   screen. `$80` (id `$111`) cycles flower (progressive), feather
   (progressive), star by column, restarting every screen; `$81` (id `$11A`)
   cycles star, 1-Up, vine.
6. Content 3 with bit 0 (byte `$07`, id `$122`, and the star in the `$81`
   cycle) is a star that becomes a coin when Mario already has a star
   (`CODE_00F1C9`, `bank_00.asm:12887-12891`). That is state variance but not
   a mushroom swap; out of scope here, the probe leaves it unflagged.

Progressive ids and what they give (mushroom if small, otherwise):

| Map16 id | F080 byte | Otherwise |
| -------- | --------- | --------- |
| `$117`, `$11F` | `$05` | fire flower |
| `$118`, `$120`, `$12A` | `$09` | feather |
| `$111` | `$80` | fire flower in columns 0, 3, 6, 9, 12, 15 of a screen; feather in columns 1, 4, 7, 10, 13; (star in 2, 5, 8, 11, 14) |

The premise holds: both flower and feather progress. The probe prints the
whole reachable table on every run.

## Map $003

Level data (one screen, expanded by the repo's own `buildL1Inputs`) holds four
progressive blocks, all on row 20:

- `$11F` at columns 4 and 5: mushroom if small, otherwise Fire Flower.
- `$120` at columns 11 and 12: mushroom if small, otherwise Feather.

It also holds a `$126` at column 8 (content index 12, sprite `$2C`, not drawn
by this spike).

Properties sample: "Mushroom if Mario is small, otherwise Fire Flower".

## Known gaps

- #605's note about its `$117` stands corrected: the table makes `$117` a
  progressive flower block, not a plain one; check what the ROM draws there
  before reusing that spike's labels.
- The star keeps palette frame 0 (no cycling) and items are drawn unflipped, as in #605.
- Checked by numbers only (opaque pixel and colour counts per graphic, block
  counts), not by eye; the diagonal clip is CSS `clip-path`, so its edge is
  anti-aliased in the browser.
- Only the hit from below triggers most of these blocks (`DATA_00F0A4`); not modelled.

## Two-outcome blocks (#623)

Same probe and generator, extended: `probe.ts` also renders D4 coin `$11C`, the
split block `$11F`, C4a `$11B`, and the state-dependent `$11A` (column 0), `$122`
and `$12D`; `gen.cjs` writes a second page, `two-outcome.html` (gitignored), with
one sheet per option at 1x, 2x and 3x, at rest and on hover.

- A: the diagonal, coin bottom-left, star or 1-Up top-right.
- B: the coin only.
- C: the conditional item only.
- D: the coin with the item as a half-size badge in its top-right corner.

Rules: `$11A` column 0 and `$122` give a star, or a coin when Mario already has
one (`CODE_00F1C9`, `bank_00.asm:12887-12891`); `$12D` gives a 1-Up once its
counter is zero, else a coin (`bank_00.asm:12861-12866`). ASM reading only; the
probe throws if the tables stop saying so.
