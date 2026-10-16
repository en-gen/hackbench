# Floating Spike Ball sank 32 px: the loader skipped the Layer 3 handler (#842)

Sprite $A4 INIT drew 32 px below its list y on map $102 (9 records, the "S" group of
[grader-triage.md](grader-triage.md)). Cause, then fix.

## Mechanism (SMWDisX, bank_00.asm and bank_01.asm)

1. INIT is `InitFloatSpkBall` (`bank_01.asm:6795`), which falls into `InitFloatingPlat`
   (`bank_01.asm:6815-6834`): up to four 8 px steps down, stopping at the first step where
   `SpriteInLiquid` ($164A) is set, then `CODE_01B262` (`bank_01.asm:6842`) re-runs INIT next frame.
2. Liquid is set by `CODE_019140` (`bank_01.asm:2433`). With `LevelIsWater` ($85) zero it reads one Map16
   tile (`CODE_019211`, `bank_01.asm:2544-2575`; page-0 tiles below 6 count as liquid). Map $102 has no such
   tile at the list y: its water is a Layer 3 tide, not Map16.
3. A tide level makes the sprite look at the tide through the second pass of `CODE_019140`
   (`bank_01.asm:2442-2489`), which runs only when `ScreenMode` ($5B) bit 7 is set and reads the
   tile at the sprite position plus the Layer 2/3 offset ($26-$29). Both come from the Layer 3 handler
   `CODE_009FB8` (`bank_00.asm:4139`): `CODE_00A045` sets the bit and clears the Layer 2 buffer
   (`bank_00.asm:4219-4238`), the handler sets `Layer3YPos` ($24, `bank_00.asm:4156-4162`), and
   `CODE_05BC4A` (`bank_05.asm:4491-4512`) writes $26-$29.
4. `GM12PrepLevel` calls `CODE_009FB8` after the level data loads (`bank_00.asm:4870`). The runner's
   level loader (`LevelLoader.ts`) ran the GM11 steps only, so $5B, $24 and $28 stayed 0, nothing read as
   liquid, and INIT sank until the sprite left the level (y $1B0 reads as tile 0, which is liquid).

## Evidence scope

One machine, vanilla ROM, the level-load capture set (`layers_v5`), measured 2026-10-16, 1957 records.

- Maps $002, $102 and $127: the loaded image equals the hardware `frame_0000` WRAM at $5B (bit 7 set),
  $24 and $28 (and $29, $26, $27, $1E, $20), cell by cell. Maps $0BE and $0C1 equal at $5B, $24 and $28
  but not at $26/$27 (loader $00 and $74/$FD, hardware $0E/$01 and $82/$FE). Before the fix: $5B 0,
  $24 0, $28 0.
- Not modelled, so $26-$29 are right only where the camera happens to agree: `CODE_05BC4A`
  (`bank_05.asm:4491-4512`) computes $26/$28 from `NextLayer1XPos`/`NextLayer1YPos` (and the Layer 2/3
  positions) at load. The runner seeds a camera of its own and never recomputes them, and it does not run
  the eight scroll steps `GM12PrepLevel` takes after the handler (`CODE_00A5F9`, `bank_00.asm:4871`,
  `4891-4900`). Map $0C2 (not a tide level; $5B is 1) shows the gap: hardware $28/$29 are $48/$FC, the
  loader's $00. Nothing in the grader depends on it yet; a sprite that reads the Layer 2/3 offset on a
  map with a scrolled camera could.
- The loader skips the handler when `IRQNMICommand` ($0D9B) bit 7 is set, as `GM12PrepLevel` does
  (`bank_00.asm:4861-4863`, boss rooms; the header loader sets the cell from `SpecialLevTable`,
  `bank_05.asm:551`). Maps $096, $097, $196, $197 take that branch.
- The 9 records of map $102 end at anchor y 400 or 384 (hardware first draw 397-399 and 383), where
  they ended at 432.

## Fix

`loadLevelState` runs `CODE_009FB8` as its last step, with a shape check on its first bytes, unless
`IRQNMICommand` bit 7 is set. A ROM whose handler differs is refused by name, as the other loader
entries are.

Grading was fixed alongside. The capture records a sprite at its first OAM write
(`headless_capture.lua`, snapshot at the slot's first write in $0200-$049F outside $0400-$041F, while
$15E9 is the slot), so a sprite that draws and then moves (the dolphin, `DolphinMain`) was graded from its
position after the move. `Machine` now records that position (`PassResult.drawPos`) and
`passPieces` measures offsets from it.

## Measured (grader, 1957 records, 'rom' seed, hardware timeline)

|                           | exact | shape | close | wrong | empty | missAtK |
| ------------------------- | ----- | ----- | ----- | ----- | ----- | ------- |
| develop                   | 998   | 803   | 18    | 125   | 13    | 25      |
| handler only              | 1022  | 808   | 17    | 110   | 0     | 3       |
| handler and draw position | 1830  | 0     | 17    | 110   | 0     | 3       |

Record by record against develop: 832 better, 0 worse, 1125 unchanged. The handler alone fixed the 9
$A4 on map $102, 13 $5D on map $102 (empty to exact), 6 $16 on map $127 and 1 $15; it made 5 dolphins on
map $002 grade shape instead of exact, because they now move in liquid and draw before they move. Grading
at the draw position fixes those, and the 808 shape results (all now exact).
Matching the capture's sample point exactly (slot check and the size-table range) changed no count.
