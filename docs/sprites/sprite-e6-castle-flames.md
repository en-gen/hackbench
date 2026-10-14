# Sprite $E6: castle candle flames on Layer 2 (#894)

How the map view draws them, and what each step rests on.

## In the game

- `CODE_02AAC0` branches to `CODE_02AA6C` on id $E6 (SMWDisX `bank_02.asm:5631-5637`);
  the level's sprite loader reaches it from `CODE_02A8C0` (`bank_02.asm:5348-5355`).
  The spawn sets four cluster sprites of type 5 at X `DATA_02AA68[slot]`
  (`$50,$90,$D0,$10` for slots 0-3; `bank_02.asm:5579-5580`), Y $F0, and
  `ClusterSpriteMisc0F4A = slot * 4` (`CODE_02AA6C`, `bank_02.asm:5582-5598`; the
  Misc store is at 5595). The cluster loop `CODE_02F808`/`CODE_02F810` calls
  `CODE_02F821` per slot, whose `JSL ExecutePtr` dispatches on the type
  (`bank_02.asm:15942-15963`).
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
- A routine or call-path part that is not the vanilla shape does not blank the flames
  (owner ruling D52, option B; `rom-interpretation.md` "Viewers draw, they do not blank").
  The ROM's own code is still run, at the vanilla entries, and the result is marked
  unverified with a map note naming each part that differs: the spawn and draw routines
  (SHA-256 of each), the loader route (`bank_02.asm:5348-5355`), the `CODE_02AAC0` entry
  and its `$E6` branch (`5631-5637`), the cluster loop and its `JSR CODE_02F821`
  (`15942-15958`), the `JSL ExecutePtr` and its target (`15962-15963`), and the type-5
  dispatch entry. A hacked call path is NOT followed (that would be an emulator): the flames
  come from the routines as they stand, and the note says the path to them is unverified.
  The data tables the routines read are not part of any check.
- What still refuses, with the reason in the map note: no level image, a run that does not
  return or executes BRK/COP/WDM/WAI/STP or leaves ROM, and a `GetRand` that is not the
  known two-step shape but is actually fetched. The draw's `JSL GetRand` sits behind
  `SpriteLock` (set to 1 for the run), so a changed `GetRand` that never executes does not
  refuse.
- `map-sprites.ts` (`castleFlameSprites`) puts one bitmap per flame per copy in the
  sprite reply, marked `fixedTo: 'layer2'`: copies every 256 px in X and in Y across
  the map, `dy` below Layer 2's own grid (`dy = Layer1YPos - Layer2YPos` at level
  start, the same value the background is drawn with, `L2Model.ts`). Only a stream with
  a plain $E6 (extra bit 3 clear) has them; the $E6 marker stays.
- The view (`map-view-model.ts`) keeps them out of the four OAM priority planes and
  the hover doors. A flame pixel joins `spritesL2High` where Layer 2's priority plane is
  opaque and `spritesL2Low` elsewhere; `withFlameKeys` lists each right above its Layer 2
  plane when both are on one screen's list, or under `l1Low` on the OBJ screen when Layer 2
  is on the other one, so Layer 1 (both priorities) is over them and Layer 2 under them. They are
  sprites to the toggle (S). The owner ruled "over Layer 2, under Layer 1" for
  now; the general priority model is #893. On real hardware OBJ priority 0 would sit
  behind BG2 and BG1 tiles (`docs/rom/obj-priority.md` section 1).

## Evidence scope

- Vanilla USA ROM, one machine, 2026-10-11. Mesen capture `layers_v5/01f`, frames 8-24:
  OAM 124-127 at X $50 $90 $D0 $10, screen Y $30 with Layer2YPos = 192 (so Y = $F0 in
  Layer 2 space), size large, attribute $09/$49, tile $E2 or $E4 (the flicker).
  Frame 0 shows Y $F0 (drawn before the scroll was set).
- Maps drawing flames, over all 512 map numbers: 7 ($01F, $101, $10D, $1CD, $1D0, $1D4,
  $1FC). Scope: vanilla USA ROM, one run, 2026-10-14, one machine. At node-reply level,
  `castleFlamesOf` on each of the 7 gives four flames at the same Layer 2 positions
  (X $10 $50 $90 $D0, Y $F0, tile $E2, attribute $09), verified (no `unverified`):
  `CastleFlames.test.ts`, corpus-gated. On screen, only map $01F is driven, by
  `theia/browser-app/test/map-castle-flames.spec.cjs`; the other six share its routing shape
  (OBJ on the main screen, Layer 2 on the sub screen, CGADSUB 32) and are covered by the
  synthetic split-list test in `MapFlamePlanes.test.ts`, not by a run in the app.
- Layer routing on those 7 maps: OBJ is on the main screen and Layer 2 on the sub screen, so
  `withFlameKeys` lists the flame planes on the main list right under `l1Low` (over the sub
  screen's Layer 2, under Layer 1: owner ruling), not beside `l2Low` / `l2High`.
- Not modelled: flicker (the map shows tile $E2), other cluster sprites ($E2-$E5),
  Layer 2 scrolling after level start.
