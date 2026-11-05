# Sprite $1F (Magikoopa): draw routine, pose cycle and runtime palette

Derivation store for `MagikoopaAppearance` and `DynSpritePalette`. Source files
carry a one-line citation pointing here instead of an inline narration block.

Every line number below was read out of `C:\Projects\SMWDisX` on 2026-09-18 and
re-checked instruction by instruction, not copied from an earlier summary. ROM
addresses were confirmed against the six ROMs in `test/roms/` (vanilla, the
Lunar-Magic-headered copy, and four hacks); all six agree byte for byte at every
address named here.

## 1. Dispatch

`Magikoopa` (`bank_01.asm:8413`) never draws. It masks `SpriteTableC2` with `$03`
and `JSL ExecutePtr` into a 4-entry table (`bank_01.asm:8421`):

| C2 & 3 | Routine | Behaviour |
|---|---|---|
| 0 | `CODE_01BDF2` | teleport search, no draw |
| 1 | `CODE_01BE5F` (`bank_01.asm:8480`) | fade in; `SpriteMisc1602 = 0`, then `SubSprGfx1` |
| 2 | `CODE_01BE6E` (`bank_01.asm:8493`) | visible cast cycle, `SubSprGfx1` plus wand |
| 3 | `CODE_01BF16` | fade out; `SpriteMisc1602` keeps state 2's last value |

`MagikoopaAppearance` models state 2 only. States 1 and 3 are a teleport fade the
editor has no frame clock for.

## 2. Tile layout: SubSprGfx1

`SubSprGfx1` (`bank_01.asm:3920`) is the 16x32 variant. It writes exactly two
large (16x16) OAM entries selected by a single value, `SpriteMisc1602`:

```
idx    = SprTilemapOffset[$1F] + SpriteMisc1602 * 2   (bank_01.asm:3937-3940)
top    = SprTilemap[idx]      at (_0, _1)
bottom = SprTilemap[idx + 1]  at (_0, _1 + $10)
```

There is no per-tile attribute table. Both entries share one byte:
`SpriteOBJAttribute | SpriteProperties`, X-flipped when `SpriteMisc157C` bit 0 is
CLEAR (`bank_01.asm:3957-3962`).

### Anchoring

Magikoopa does not pre-shift `SpriteYPos` before the `JSR`. `Spr0to13Gfx` does:
`CODE_018BEC` subtracts `#$0F` from `SpriteYPosLow` and `#$00` from
`SpriteYPosHigh` around its draw call (`bank_01.asm:1772-1774`). Magikoopa's
state-2 `JSR SubSprGfx1` at `bank_01.asm:8529` has no such wrapper, so the top
tile sits ON the spawn row and the body spans `y..y+32`, not `y-16..y+16`.

`SpriteTileLoader`'s generic `sub1` path still uses the `-16/0` anchoring, which
is the `Spr0to13Gfx` case. Ten other `sub1` IDs have not been traced to their
callers and may share the 16px offset error:

    $1A  $1E  $22  $23  $24  $25  $2A  $41  $42  $43

Tracking list only. Not fixed on this branch.

## 3. Pose cycle

State 2 computes `SpriteMisc1602` from the countdown timer `SpriteMisc1540`
(`CODE_01BE96`, `bank_01.asm:8513-8528`):

```
Y     = SpriteMisc1540 >> 6          ; six LSRs, bank_01.asm:8514-8520
bit   = (SpriteMisc1540 >> 3) & 1    ; three LSRs + AND, bank_01.asm:8522-8526
Misc1602 = DATA_01BE69[Y] | bit      ; ORA, bank_01.asm:8527
```

`DATA_01BE69` (`bank_01.asm:8487`, ROM `$01:BE69`) is the pose base per
`timer >> 6`. `DATA_01BE6C` (`bank_01.asm:8490`, ROM `$01:BE6C`) is the wand dx
per `SpriteMisc157C`.

The timer enters state 2 at `$70` (`LDA #$70`, `bank_01.asm:8729`, ROM
`$01:C022`; the operand byte is at `$01:C023`). `timer >> 6` therefore only ever
yields 1 then 0, so only four `SpriteMisc1602` values are reachable in state 2:
`$02, $03, $04, $05`.

`misc1602ForTimer` is defined for `timer <= $BF`. Above that, `timer >> 6` is 3
and `DATA_01BE69` has only three entries, so the function rejects the input
rather than returning `undefined | bit`.

### Top-tile bob

`bank_01.asm:8530-8539`:

```
LDA SpriteMisc1602,x : SEC : SBC #$02 : CMP #$02 : BCC + : LSR : BCC +
  LDA SpriteOAMIndex,x : TAX : INC OAMTileYPos+$100,X
+
```

Only values where `(v - 2) >= 2` and `(v - 2)` is odd, i.e. `v = 5` (and `v = 7`,
unreachable here). Values 2 and 3 fall out at the first `BCC`. The `INC` targets
`+$100`, the TOP entry only.

### Wand

`bank_01.asm:8545-8547`: `LDA SpriteMisc1602,x : CMP #$04 : BCC Return01BF15`, so
the wand is drawn for `$04` and `$05` only.

The wand char is `LDA #$99` at `bank_01.asm:8570`, ROM `$01:BF04` (`A9 99`; the
operand byte is at `$01:BF05`, which is followed by another `$99` byte, so a
single-byte anchor there cannot detect a one-byte drift). Its Y is
`SpriteYPosLow - Layer1YPos + $10` (`ADC #$10`, `bank_01.asm:8560`). It goes to
OAM slot `+$108`, behind the body's `+$100` / `+$104`, so a renderer that blits in
array order must emit the wand first.

## 4. Runtime palette: MagiKoopaPals

`Sprite166EVals[$1F]` (`bank_07.asm:792`, read at `bank_07.asm:977`) is `$4F`;
`& $0F` gives `$0F`, so every `$1F` tile is on OBJ palette 7 = CGRAM row 15.

The level's static row 15 is not what the hardware shows. The teleport fade
leaves a runtime-uploaded palette in CGRAM colors `$F0..$F7` and state 2 never
overwrites it.

### Transport

`DynPaletteTable` (`$7E0682`, `rammap.asm:1157-1164`) is a list of entries, each
with a 2-byte header: byte 0 = number of bytes to upload, byte 1 = CGRAM **word**
address. `CODE_00A488` (`bank_00.asm:4714`) writes that second byte straight to
`HW_CGADD` (`$2121`) at `bank_00.asm:4735` and DMAs the body to `$2122`, so the
address is a color index, not a byte address. A byte count below `$20` therefore
rewrites only PART of a 16-color CGRAM row.

### The upload

`CODE_01C028` (`bank_01.asm:8733`) indexes `MagiKoopaPals` with
`(SpriteMisc1570 - 1) << 4` (`DEC A` plus four `ASL`, `bank_01.asm:8734-8740`) and
copies `$10` bytes, so an entry is 16 bytes = 8 BGR555 colors. It writes the
header `$10 / $F0` (`bank_01.asm:8752-8755`): 8 colors at CGRAM index `$F0` =
row 15, columns 0-7. Columns 8-15 of row 15 are never touched, so a consumer must
composite rather than replace.

### Which values are read from the ROM, and which are not

Only the color bytes themselves are read from the ROM at runtime. `addr`,
`colorsPerEntry`, `entryCount` and `cgramStart` are hardcoded literals in
`DynSpritePalette.ts`, each derived once from the instructions below and
re-checked by `DynSpritePalette.test.ts` against the ROM:

| Field | Derived from | ROM address |
|---|---|---|
| `addr` = `$03B902` | operand of `LDA.L MagiKoopaPals,X` (`bank_01.asm:8743`) | `$01:C036` (`BF 02 B9 03`) |
| `colorsPerEntry` = 8 | the four `ASL`s, and the `CMP #$10` / `LDA #$10` pair | `$01:C02C`, `$01:C043`, `$01:C04A` |
| `entryCount` = 8 | gap to the next label `BooBossPals` (`bank_03.asm:7321`, `$03:B982`), read as the operand of `LDA.L BooBossPals,X` (`bank_03.asm:327`) | `$03:8254` |
| `cgramStart` = `$F0` | header immediate `LDA #$F0` (`bank_01.asm:8754`) | `$01:C04F` |

`restingEntry` is the exception: it is resolved from the ROM at load time. See
below.

### restingEntry

`CODE_01C004` (`bank_01.asm:8715`) drives the fade-in. It increments
`SpriteMisc1570` on a 4-frame timer and falls through to `CODE_01C028` to upload
entry `SpriteMisc1570 - 1`, until `SpriteMisc1570` reaches the terminal value, at
which point it advances `SpriteTableC2` into the visible state instead and
uploads nothing. So the last entry left in CGRAM is `terminal - 2`, which is 7 in
vanilla.

There are TWO `CMP #$09` in that routine and they gate different things:

| ROM address | ASM | Gates |
|---|---|---|
| `$01:C014` | `CMP #$09 : BNE +4` | `bank_01.asm:8722-8725`, `LDY #$24 : STY ColorSettings` only |
| `$01:C01C` | `CMP #$09 : BNE +8` | `bank_01.asm:8726-8727`, the branch to `CODE_01C028`, i.e. the palette upload |

The upload gate is `$01:C01C`. `$01:C014` is the ColorSettings gate and happens to
hold the same immediate in vanilla, so anchoring the derivation there gets the
right number for the wrong reason.

`resolveRestingEntry` reads the immediate at `$01:C01C` and returns `imm - 2`.
A hack that shortens the fade (say `CMP #$05`) makes hardware rest on rung 3, and
the editor now follows. Evidence scope: all six ROMs in `test/roms/` hold
`C9 09` at `$01:C01C`, so this changes nothing observable on any ROM currently
tested; it removes a divergence that would otherwise be silent.

### Mutual exclusion with BooBossPals

`BooBossPals` is uploaded by the Big Boo boss handler with the SAME header,
`$10 / $F0` (`bank_03.asm:336-339`). Sprite `$1F` and sprites `$C5` / `$C6`
therefore contend for CGRAM colors `$F0..$F7` and cannot both show their runtime
palette at the same time on hardware. The `DynSpritePalette` interface has no
field expressing that; a consumer that renders both would need one.

### Editor divergence from hardware

In game the CGRAM write is global: once the fade has run, every OBJ-palette-7
sprite on screen sees the spliced row. The editor applies the splice only inside
`MagikoopaAppearance.render`, so other OBJ-palette-7 sprites in the same level
(`$6D`, `$6E`, `$6F`, `$AF`, `$B0`, `$C5`, `$C6`, `$F6`, `$F8`) keep the level's
static row.

This is a deliberate editor convention, not an oversight: at level start, before
any Magikoopa has teleported in, the static row IS what is in CGRAM, so the
static row is the right thing to show for sprites that do not write it
themselves. It is still a divergence from the post-fade hardware state.

That list of nine is not folklore: it is every sprite ID other than `$1F` whose
`Sprite166EVals` entry (`bank_07.asm:792`, read at `bank_07.asm:977`, ROM
`$07:F3FE`) selects OBJ palette 7, i.e. `(val & $0F) >> 1 == 7`. Enumerated over
all 256 IDs on the vanilla ROM.

## 5. Map view colors (#1097)

Symptom: on map `$11C` the map view drew the Magikoopa in the level's pink row
15 where the game shows blue.

Cause, measured on the vanilla ROM (one machine): the map view runs the ROM's
own sprite code at rest for 64 passes (`SpriteSeed.ts` `mainPasses`) and draws
the FIRST pass that draws a tile, with the CGRAM writes made up to that pass.
For `$1F` on `$11C` that pass is pass 1. It draws the casting pose on leaving
state 0 (`JSR CODE_01BE82`, `bank_01.asm:8474`; the wand tile `$99` is written
only on that path, `bank_01.asm:8570-8571`), and no rung has been uploaded yet:
state 1 uploads from its first pass on (`CODE_01C004`, `bank_01.asm:8715-8732`,
upload `CODE_01C028`, `bank_01.asm:8733-8755`). That pass had written nothing,
so row 15 fell back to the level's colors. By pass 63 all eight rungs are
written and the last stays in CGRAM (vanilla `$11C` settles at pass 30).

| | CGRAM row 15 columns 0-7 |
|---|---|
| map view before | the level's row (no sprite write) |
| game (capture `layers_v5/11c`, `windows/screen_00`) | `MagiKoopaPals` entry `CMP imm - 2` = entry 7 |
| map view after | the same entry |

Columns 8-15 are never written, so they keep the level's colors (composited,
not replaced). In the capture the sprite is OAM entries 116 and 117 on
palette 7.

Fix (`theia/extension/src/node/map-sprites.ts`, `runtimeColors`), for every
sprite and with no id test: draw the colors CGRAM holds at the end of the run
(the run's net writes, last write per color wins, drawn pass or not). The
picture is marked `unverified` ("... so they may differ in the game") when
those colors may not be the settled ones:

1. a color changed at any pass of the last 16 (every pass of the tail is
   compared with the one before). A vanilla fade writes a rung every 4 passes,
   so a fade up to 4x slower is caught;
2. the sprite's first drawn pass is inside that tail (a late start has had no
   time to write, so a quiet tail proves nothing). The test uses the run's
   first drawn pass, not the pass a frame of the animation is drawn from;
3. the sprite stopped drawing at some pass after its first and its end colors
   differ from those at its first drawn pass (not the frame being drawn): a fade-out followed by a new cycle.

A run of 16 passes or fewer is not checked: that guards the tail loop and keeps
hand-built models from being marked; no production run is that short. The run is not
lengthened. Whether the fade finishes depends on the placement: state 0 waits
on `GetRand` and a ground test.

Evidence (vanilla ROM, one machine):

- Placed spot on `$11C`: 262 of 387 opaque pixels were not a captured row-15
  color before, 0 after, not marked.
- Every vanilla sprite on the 488 maps that build (3387 sprites; 24 maps did
  not build) and every frame `framesOf` gives them (8879): bitmaps identical to
  develop for all but `$1F` on `$11C` (1 sprite, 2 frames), and 0 sprites and 0
  frames newly `unverified`. The net CGRAM colors of `$C5` (`BooBossPals`) are
  the same on all 64 passes; only the length of its write list differs.
- Grid of the `$1F` placement over `$11C` (screens 0-9, every 3rd tile, 540
  spots, stream bytes patched): 294 draw, of which 192 are correct and not
  marked, 77 are on a rung before 7 (3 with no write at all, the original bug)
  and all 77 are marked, 25 are correct and marked anyway (their colors settled
  inside the last 16 passes); none is wrong without a mark. Same grid on
  `$1FE`: 217 draw; 134 correct and not marked, 40 wrong and marked, 43 correct
  and marked; none wrong without a mark.
- Timing patches at the `$11C` placed spot (picture wrong against rung 7 in all
  of them):
  - marked: `$01:C00A` = 10 or 16; `$01:C023` = 4; the fade-out cases
    (`$01:C00A`/`$01:C023` = 3/1, 3/2, 3/4, 3/6, 2/12, 1/20, where the sprite
    fades out, leaves and starts a new cycle);
  - NOT marked (silent), measured at the `$11C` placed spot for `$01:C00A`
    9 to 70: 9-20 marked; 21 and 22 silent (rung 2); 23-30 marked; 31-45
    silent (rung 1); 46-61 marked; 62-70 silent (rung 0); not run above 70.
    The cause is that no rung lands in the last 16 passes. A wider sweep by the
    reviewer (`$01:C00A` 1-40, 14 `$01:C023` values, 4 `$01:BFE9` values) had
    silent wrong results only at `$01:C00A` 21, 22 and 31-40. One machine,
    vanilla ROM. A fade whose rungs land more than 16 passes apart is a known
    limit of this check.
- `$1FE` at its placed spot draws no tile in the run (a placeholder): it has no
  pixels to compare, and there is no capture for it (`captures/layers_v5/1fe.zip`
  does not exist), so nothing is claimed about its colors.

The all-vanilla comparison is not a committed test: it needs a develop run to
compare against and takes minutes. The committed tests are
`MapSpritesMagikoopaPalette.test.ts` (synthetic) and the `$11C` capture
comparison `MapSpritesMagikoopaPalette.corpus.test.ts`. The Playwright spec is
`theia/browser-app/test/map-magikoopa-palette.spec.cjs`. The pose shown is the
casting pose; that is a pose-policy matter separate from the colors.
