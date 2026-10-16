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

One machine, vanilla ROM, the `layers_v5` capture set. For maps $002, $102 and $127 the loaded image now
equals the hardware `frame_0000` WRAM at $5B ($80), $24 and $28-$29 (checked cell by cell). Before:
$5B 0, $24 0, $28-$29 0. The 9 records of map $102 end at anchor y 400 or 384 (hardware first draw 397-399
and 383), where they ended at 432.

## Fix

`loadLevelState` runs `CODE_009FB8` as its last step, with a shape check on its first bytes. A ROM
whose handler differs is refused by name, as the other loader entries are.

## Side effects measured (grader, 1957 records, 'rom' seed, hardware timeline)

| | exact | shape | close | wrong | empty | missAtK |
| --- | --- | --- | --- | --- | --- | --- |
| before | 998 | 803 | 18 | 125 | 13 | 25 |
| after | 1022 | 808 | 17 | 110 | 0 | 3 |

Better: $A4 x9 (wrong to exact), $5D x13 on map $102 (empty to exact), $16 x6 on map $127, $15 x1 on map
$102. Worse: the vertical dolphin ($43 x4, $C3 x1) on map $002, exact to shape. They were exact only
because the dolphin never saw liquid and so never moved; in liquid it takes `DolphinMain`'s Y speed
(`bank_02.asm`, `DolphinMain`) and moves 3 px a frame, and it draws before it moves, so the grader's
offset from the sprite's post-move position is off by that move. The same draw-before-move gap exists
for any moving sprite the grader reads this way (`DRAWS_BEFORE_LINE_SNAP` in `SpriteRunner.ts` holds
only $67); it is not fixed here.
