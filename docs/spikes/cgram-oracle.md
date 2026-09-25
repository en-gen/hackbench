# CGRAM oracle

Adds palette to what the Mesen-dump regression oracle can fail on. The
existing verdict (`hackbench-mapviewer-tests/scripts/run-map-diff.ts` via
`tools/scripts/gen_diff_images.ts`) counts per-cell Map16 tile-id mismatches
only, so a wrong palette passes silently.

## Why hardware CGRAM, and why it is not circular

`capture/mesen/headless_capture.lua` in
[en-gen/hackbench-validation](https://github.com/en-gen/hackbench-validation)
dumps 512 bytes of PPU CGRAM
(`emu.memType.snesCgRam`) at each sample frame. That is what the PPU held,
not a re-derivation of our own ROM tables, so comparing `buildLevelCgram`
(`src/rom/PaletteLoader.ts`) against it tests the derivation rather than
assuming it.

Two things it is deliberately *not*:

- Not `MainPalette` (`$7E0703`, `rammap.asm:1175`), the game's own WRAM
  staging buffer. That buffer is already inside the 8 KB WRAM dump the
  capture has always taken, so a palette check could have been built from it
  without touching the Lua at all -- but it is not the end state. Measured on
  12 levels, CGRAM and `MainPalette` disagree at `$64` and `$86-$8F`: the
  player palette reaches CGRAM by a direct DMA (`MarioGFXDMA`,
  `bank_00.asm:4551-4566`, `CGADD = $86`, 20 bytes) that never passes through
  `MainPalette`.
- Not our own Map16 decode. Checking rendered palette against our Map16
  attribute bits would test the renderer while assuming the derivation, and
  the derivation is where the shipped bugs were.

## Index buckets

`src/rom/CgramOracle.ts` splits the 256 CGRAM entries three ways. Every span
is cited to the routine that writes it; the routine is `LoadPalette`
(`bank_00.asm:5595-5699`) unless noted.

**ROM-written (178 indices, 177 compared).** A mismatch here is a derivation
bug.

| indices | source | citation |
|---|---|---|
| col 1, rows 0-7 | `$7FDD` | `bank_00.asm:5597-5601` |
| col 1, rows 8-15 | `$7FFF` | `bank_00.asm:5602-5604` |
| rows 0-1 cols 8-15 | StatusBarColors | `bank_00.asm:5605-5613` |
| rows 4-13 cols 2-7 | StandardColors | `bank_00.asm:5614-5622` |
| rows 2-3 cols 2-7 | ForegroundPalettes[variant] | `bank_00.asm:5629-5645` |
| rows 14-15 cols 2-7 | SpriteColors[variant] | `bank_00.asm:5646-5662` |
| rows 0-1 cols 2-7 | BackgroundPalettes[variant] | `bank_00.asm:5663-5679` |
| rows 2-4 cols 9-15 | BerryColors | `bank_00.asm:5680-5688` |
| rows 9-11 cols 9-15 | BerryColors | `bank_00.asm:5689-5697` |
| row 8 cols 6-15 | PlayerColors, DMA straight to CGRAM | `bank_00.asm:4551-4566` |

**Never written (62 indices).** No level-load path writes them. Agreement
here is close to worthless -- both sides are zero on every level measured --
and it is reported separately for that reason. Its one job is catching
colors we invent where the ROM writes none, which is exactly the defect it
found (see below).

**Excluded (17 indices).**

- Col 0 of all 16 rows. Index `$00` is the PPU backdrop; the other 15 are
  never sampled by BG or OBJ. `buildLevelCgram` represents them as alpha-0 on
  purpose, so an RGBA comparison there tests nothing.
- `$64` (row 6 col 4), animated per frame during a level. Measured: on 11 of
  the 12 levels captured it is the *only* index that differs between sample
  frames +0, +30 and +60; on `$002` no index changed across the three frames.
  It is also one of the two places CGRAM diverges from `MainPalette`, so the
  animation writes CGRAM directly.

## How much of the agreement is load-bearing

Measured over 12 levels, frame +0, vanilla ROM:

| bucket | indices | vary across the 12 levels | all-zero baseline scores | constant-table baseline scores |
|---|---|---|---|---|
| ROM-written | 177 | 34 | 13.6% | 84.7% |
| never written | 62 | 0 | 100% | 100% |

So a stub that returned one level's palette for every level would already
agree on 84.7% of the load-bearing comparisons. Only the 34 varying indices
discriminate between levels. Read a green run as "the 34 discriminating
indices agree", not as "239 independent checks passed".

## Running it

```powershell
# capture, from an en-gen/hackbench-validation checkout
# (writes only to the directory you name; never to OneDrive)
./capture/scripts/run_headless_capture.ps1 -OutputDir <scratch>/11e -LevelId 0x11E
```

```bash
npx tsx tools/scripts/check_cgram.ts <scratch> [--frame 0000] [--verbose]
```

Exit 0 all agree, 1 at least one disagrees, 2 nothing was compared. Exit 2 is
a failure on purpose: a verdict computed over zero inputs is not a pass.

## Proven able to fail

`test/suite/unit/CgramOracle.test.ts` plants defects in a synthetic palette
(no ROM bytes, no captures committed) and asserts the comparison goes red:
a wrong background-palette variant, a color invented where the ROM writes
none, a one-step BGR555 error, and -- because a defect planted at one
convenient index proves nothing about the rest -- a sweep that plants one at
every single compared index and asserts all 239 are caught. A matching sweep
over the 17 excluded indices asserts none of them are, so the exclusions are
exactly as wide as this document says.

End to end, on real captures: flipping one bit of `frame_0000_cgram.bin` at
index `$22` turned `$11E` from PASS/exit 0 to FAIL/exit 1 naming `$22`.

## What it found

**Fixed here.** `buildLevelCgram` filled rows 5-7 cols 9-15 from `$00B552`.
That address is inside `OWStdColors` (`SMW_U.sym:10998`), overworld data with
no level-load path to CGRAM; hardware holds `$0000` there on all 12 levels
captured. 18 indices on every level.

**Open, not fixed.** On 5 of 12 levels the runtime palette-variant RAM
(`ForegroundPalette $7E192D`, `SpritePalette $7E192E`, `BackgroundPalette
$7E1930`, `rammap.asm:1958-1961`) does not hold the value our header parse
derives, even though the header bit extraction matches `CODE_0584E3`
(`bank_05.asm:523`) exactly:

| level | header bg/fg/sp | runtime bg/fg/sp | CGRAM rows affected |
|---|---|---|---|
| `$004` | 1/4/5 | 6/4/0 | 0-1, 14-15 |
| `$007` | 3/3/1 | 1/3/1 | 0-1 |
| `$013` | 6/4/5 | 6/4/0 | 14-15 |
| `$0C8` | 5/1/2 | 1/1/2 | 0-1 |
| `$111` | 3/7/1 | 1/3/1 | 0-1, 2 |

No level header in the ROM produces the runtime tuple for `$004`, `$007`,
`$013`, `$0C8` or `$111`, so the values are not simply another level's header
being parsed. A candidate path is `CODE_0CABB2` (`bank_0C.asm:3148`), which
uploads `BackgroundPalettes[DATA_0CABAB[LevelLoadObject]]` straight to CGRAM
words `$02` and `$12` through `DynPaletteTable` -- the exact indices that
mismatch -- but that has not been traced to a conclusion and does not yet
explain the RAM values. This is a real divergence between our renderer and
hardware and needs its own investigation.
