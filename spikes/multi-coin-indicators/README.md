# Multiple-coin block indicators

Issue #615. Builds on the D4 pick of [block-content-indicators](../block-content-indicators/README.md)
(#566, single coin = content index 6) and the DH pick of
[progressive-powerup-indicators](../progressive-powerup-indicators/README.md) (#607).
Status: mockup for the owner to pick from; spike code, not product code.

Question: a multiple-coin block pays one coin per hit until a timer runs out.
There is no fixed count, so no numeral. How does the D4 indicator tell it from
a single-coin block?

## Rebuild the mockup

Prerequisites as in the #605 spike (`npm ci`, vanilla ROM found through
`test/suite/support/corpus.ts`).

```bash
npx tsx spikes/multi-coin-indicators/probe.ts   # reads the tables, composes the candidates, writes assets.json
node spikes/multi-coin-indicators/gen.cjs       # builds mockup.html
```

Both files land here and are gitignored (they embed ROM graphics). Both
scripts take optional path arguments, as in #605. The probe imports the PNG
and sprite helpers from `../block-content-indicators/lib.ts`.

## Candidates (all D4: half scale in the bottom-right quadrant, full block on hover)

Each is a 16x16 graphic built from the coin sprite, shown in the quadrant at
rest and over the whole block on hover.

- C1: three coins stacked on a diagonal, bottom-left in front (recommended).
- C2: one coin plus a small white "+" with a 1px black edge, top right.
- C3: a small pile, two coins at the base and one on top.

The page shows, per candidate, a real map window at 1x, 2x and 3x (single-coin
blocks keep the plain D4 coin beside the multi-coin ones), then a single-coin
and a multi-coin block each at rest and hover at 4x and 8x. A comparison
section at the top shows all three on one block at 2x, 4x and 8x. A checkbox
switches the stage to a dark backdrop. The page also holds a sample
Properties "Contains" row.

Map: $123 (Forest of Illusion 3), columns 70-86, rows 13-23. It holds one real
multi-coin block, `$11B` at column 77, row 20, and two real single-coin blocks
(`$11C` at column 79 row 18 and column 76 row 21). It holds no `$123` or `$124`,
so one each is added in free cells of row 20 (columns 82 and 84, labelled "added").

## The ROM rule

Evidence: SMWDisX reading plus the table bytes read from the vanilla ROM by
the probe; not run in an emulator. Ids are Map16 ids; only page 1 (`$1xx`)
reaches the block-hit code (`bank_01.asm:2617-2623`).

1. `CODE_00F160` (`bank_00.asm:12827-12846`) turns the low byte into a table
   index `low - $11`; `DATA_00F080` (`bank_00.asm:12751`) holds the content
   byte (`CODE_00F17F`, `bank_00.asm:12859`). Content = byte >> 1.
2. Content 6 is one coin. Content 7 is multiple coins: in
   `bank_02.asm:1062-1067` content 7 sets `MulticoinTimer` to `$FF` if it is
   zero, and both 6 and 7 then spawn a coin through the same call.
3. `DATA_00F080` has byte `$0C` (content 6) at table indices `$0B` and `$13`
   and byte `$0E` (content 7) at indices `$0A` and `$12`. Ids:

| Map16 id | F080 byte | Content | Bounce sprite (`DATA_00F05C` + 1) |
| -------- | --------- | ------- | --------------------------------- |
| `$11C`   | `$0C`     | one coin | 1, "Turn Block without turn" (`bank_02.asm:2118`) |
| `$124`   | `$0C`     | one coin | 3, "Question Block" (`bank_02.asm:2120`) |
| `$11B`   | `$0E`     | multiple coins | 1, "Turn Block without turn" |
| `$123`   | `$0E`     | multiple coins | 3, "Question Block" |

   Index `$1D` (`$12E`, also byte `$0C`) is never reached (`CODE_00F160`
   skips indices `$1D-$21`), so it is dead data. The column-dependent bytes
   `$80`/`$81` pick from `DATA_00F100` (`bank_00.asm:12778`), which holds no
   content 6 or 7 (the probe checks), so they add no coin blocks.
4. The multi-coin block regenerates as itself while the timer runs:
   `DATA_00F0C8` (`bank_00.asm:12765`) gives generate-tile `$0A`/`$0B` for
   `$11B`/`$123`, and `TileToGeneratePg1` (`bank_00.asm:7425`, index = tile - 9)
   maps those to `$1B`/`$23` on page 1. `TileFromBounceSpr0`
   (`bank_02.asm:2276-2287`) keeps that tile until `MulticoinTimer` reaches 1,
   then generates the Used block. The probe asserts both regenerate as
   themselves. `CODE_02902D` (`bank_02.asm:2090-2096`) counts the timer down
   while sprites are not locked.
5. The game gives each of the four ids the same graphic as its partner, cell
   for cell (probe output: `$11B` = `$11C`, `$123` = `$124`, same chars and
   palettes), so a single-coin and a multi-coin block cannot be told apart
   on the map without an indicator. This holds for the level in the mockup;
   other tilesets draw these ids through their own Map16 tables.

Out of scope: the green star block (`DATA_00F080` `$FF`, `$12D`).

## Number checks

The probe checks by numbers (opaque pixels, colours, bounding box, visible
pixels per element) and fails the run on a bad graphic. It first proves the
check can fail: a blank canvas and a candidate with one coin hidden are both
rejected. The 16x16 canvas is drawn into the 8x8 quadrant by CSS, so "inside
the quadrant" means every opaque pixel is inside the canvas. A browser pass
over the generated page confirmed, for all 117 block elements, that the
indicator box is the bottom-right half-size quadrant at rest and the full
block when hover is forced (0 mismatches).

## Known gaps

- Checked by numbers only, not by eye. The coin is scaled by taking the most
  common colour of each source box, so small coins may lose their outline.
- At 1x the 16x16 graphic lands in 8 screen pixels by nearest-neighbour
  sampling, which drops every other pixel; judge the "+" and the coin
  separation at 2x and above.
- A real mouse hover was not exercised (the forced class uses the same CSS
  rule as the live `:hover`, copied from the #607 page).
- The star keeps its first palette frame and items are unflipped, as in #605.
