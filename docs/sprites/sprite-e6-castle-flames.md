# Sprite $E6: castle candle flames on Layer 2 (#894)

How the map view draws them, and what each step rests on.

## In the game

- `CODE_02AAC0` branches to `CODE_02AA6C` on id $E6 (SMWDisX `bank_02.asm:5631-5637`).
  The spawn sets four cluster sprites of type 5 at X `DATA_02AA68[slot]`
  (`$50,$90,$D0,$10` for slots 0-3), Y $F0, and `ClusterSpriteMisc0F4A = slot * 4`
  (`bank_02.asm:5576-5592`).
- The cluster dispatch's type-5 entry is `CODE_02FA16` (`bank_02.asm:15962-15972`).
  It draws each flame at its position minus `Layer2XPos` / `Layer2YPos`, one byte
  each, so the flames are fixed to Layer 2 and wrap every 256 px. Tile
  `CastleFlameTiles[Misc & 3]` ($E2/$E4), attribute `CastleFlameGfxProp[Misc & 3]`
  ($09/$49: CGRAM row 12, OBJ priority 0), size large, OAM 124-127. A random step
  bumps `Misc` (flicker) unless `SpriteLock` is set (`bank_02.asm:16230-16280`).

## In the editor

- `src/rom/sprites/interp/CastleFlames.ts` runs the two routines on the core over
  the level's own state (`levelSeed`), with Layer 2 at zero and `SpriteLock` set, so
  the first frame comes out (tile $E2, no flicker). Positions, tiles and attributes
  are read from the OAM they wrote; nothing is a table in the editor. The cluster
  numbers stay cleared in `levelSeed` (#809): only these runs set them, so a flame is
  never part of another sprite.
- A ROM whose routines differ in any byte (SHA-256 of each) or whose `$E6` branch or
  dispatch entry differs is refused with a reason (a note on the map), not run on a
  guess. The data tables the routines read are not part of the check.
- `map-sprites.ts` (`castleFlameSprites`) puts one bitmap per flame per copy in the
  sprite reply, marked `fixedTo: 'layer2'`: copies every 256 px in X and in Y across
  the map, `dy` below Layer 2's own grid (`dy = Layer1YPos - Layer2YPos` at level
  start, the same value the background is drawn with, `L2Model.ts`). Only a stream with
  a plain $E6 (extra bit 3 clear) has them; the $E6 marker stays.
- The view (`map-view-model.ts`) keeps them out of the four OAM priority planes and
  the hover doors. A flame pixel joins `spritesL2High` where Layer 2's priority plane is
  opaque and `spritesL2Low` elsewhere; `withFlameKeys` lists each right above its Layer 2
  plane, so Layer 1 (both priorities) is over them and Layer 2 under them. They are
  sprites to the toggle (S). The owner ruled "over Layer 2, under Layer 1" for
  now; the general priority model is #893. On real hardware OBJ priority 0 would sit
  behind BG2 and BG1 tiles (`docs/rom/obj-priority.md` section 1).

## Evidence scope

- Vanilla USA ROM, one machine, 2026-10-11. Mesen capture `layers_v5/01f`, frames 8-24:
  OAM 124-127 at X $50 $90 $D0 $10, screen Y $30 with Layer2YPos = 192 (so Y = $F0 in
  Layer 2 space), size large, attribute $09/$49, tile $E2 or $E4 (the flicker).
  Frame 0 shows Y $F0 (drawn before the scroll was set).
- Maps drawing flames, over all 512 map numbers: see the PR (7 maps).
- Not modelled: flicker (the map shows tile $E2), other cluster sprites ($E2-$E5),
  Layer 2 scrolling after level start.
