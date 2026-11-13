# Sprite $AD Wooden Spike: the 16 px it draws below map $1B

Why the off-map canvas spec (`theia/browser-app/test/map-off-map-canvas.spec.cjs`, #1233) uses map $1B as its
real-data case for a sprite below the map. All lines are SMWDisX at the checkout of 2026-11-05. No ROM bytes or
table values are copied here; the tables are described in words.

## What the game draws

- `WoodenSpike` (`bank_03.asm:2560`) calls `WoodSpikeGfx` first, then the state machine (`bank_03.asm:2595-2605`
  is a state's timer step), so the picture is drawn before any motion.
- `WoodSpikeGfx` (`bank_03.asm:2657-2704`) draws five 16x16 tiles at 16 px steps, spanning 64 px below the
  sprite's top; $AD takes the second half of the shared tables (its own five entries).
- INIT is `InitWoodSpike2`, which jumps to `InitMontyMole` (`bank_01.asm:730-734`): it stores one flag and moves
  nothing. (`$AC`'s INIT, `InitWoodSpike`, does move the sprite; $AD's does not.)

## On map $1B

Map $1B is 9 screens, 2304 x 432 px. $AD sprites at stream indexes 16, 22 and 24 stand at list y 368, so their
box is 368..448: 16 px past the map's 432 (the sprite is 80 px tall: 64 + 16). Their post-INIT anchor equals the
list position. Vanilla ROM, `mapSprites`, one machine, 2026-11-05.

## Camera range (reviewer's trace and a core sweep, not a full trace)

The 5th tile exists only while the game does not cull it. `FinishOAMWriteRt` (`bank_01.asm:7582-7658`) sets a
tile's OAM Y to the off-screen marker when `CODE_01C9BF` (`bank_01.asm:10020-10029`) finds its bottom 256 px or
more below the camera's top. For tile 5 (top 432, bottom 448) that means a camera Y of 192 or less culls it.

- Emulated CPU, vanilla ROM, one machine, one run per camera, stream indexes 0, 16, 22, 24: cameras 200 to 300 give
  5 tiles (box bottom 448); camera 192 gives 4 tiles (bottom 432, no overflow).
- The map view's camera for these sprites is 208 (`cameraFor`, `map-sprites.ts`: the 432 px map minus the 224 px view).
- The camera floor behind the 192 limit (`bank_00.asm:13656-13657`) is a lead, not a full trace.
- Indexes 22 and 24 were also run by me at 208, 240, 272 and 300: the same five tiles, anchors on the list position.

So the 16 px holds in the supported range but depends on the camera sitting at 200 or more. $9E (Ball 'n Chain) on
$0E and $110 also reaches 448, but its bottom row depends on the camera clamp too (reviewer's finding), which
makes $AD the steadier case.
