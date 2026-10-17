# Sprite $CA: Torpedo Ted launcher (#985, slice B)

How the map view draws it, and what each step rests on.

## In the game

- Ids from $C9 are shooters, not sprites. The loader (`CODE_02A8D4`, SMWDisX
  `bank_02.asm:5365-5368`) sends them to `LoadShooter`, which stores
  `ShooterNumber = id - $C8` (`bank_02.asm:5744`); $CA is number 2. Nothing is drawn
  for a shooter until it fires.
- `CODE_02B3AB` (`bank_02.asm:6830-6832`) dispatches the number; number 2 is
  `LaunchTorpedo` (`bank_02.asm:6835`). With its timer at zero (the first fire) it
  sets the timer to $50, then, if the shooter is on screen in X and not within 16 px of
  the camera's left or right edge (an 8-bit `+$10` / `CMP #$20` on X minus the camera,
  `:6850-6856`), spawns a normal sprite $44 (Torpedo Ted, status 8) at the
  shooter's position (`:6861-6863`) and extended sprite $08, the launcher arm, at
  X + 8, Y - 9 with `ExtSpriteMisc176F = $90` (`:6891-6902`).
- `LauncherArm` (`bank_02.asm:3969-4003`) draws the arm: tile $84 while the counter
  is $60 or more (it spawns at $90), else $A4; attribute $13 (palette 1, priority 1);
  16 x 16.

## In the editor

- `src/rom/sprites/interp/TorpedoLauncher.ts` seeds one shooter in the level's own
  state (`levelSeed`) with its timer at 0 (`LoadShooter` stores $10, `bank_02.asm:5776-5777`;
  the game has counted it down by the fire frame) and SpriteLock set (the arm's and the
  torpedo's steps are skipped, so the spawn frame shows, the map view's frame policy). It
  runs `CODE_02B3AB`, then the game's own sprite loop on the slot `LaunchTorpedo` filled
  (the slot in status 8, whatever its number), then `LauncherArm`, all in one machine.
- The torpedo is NOT a fresh run of sprite $44. `LaunchTorpedo` writes `$157C` (direction
  toward Mario, `SubHorzPosBnk2`, `:6874-6876`) and `$1540 = $30` (`:6878-6879`) into the
  slot after `InitSpriteTables`; `TorpedoGfxRt` reads them (`$64 = $10`, behind objects,
  `:7480-7483`; X flip from `DATA_02B8F5`, `:7541`; back tile $82, `:7570-7573`). A rerun
  from INIT (a bare return, `bank_01.asm:652`) loses both. Mario is `seed.mario` ($94/$96
  and $D1/$D3); the map view passes the level loader's entrance position, as for every sprite.
- A hack whose `LaunchTorpedo` spawns another number draws that sprite, flagged `unverified`
  with the number; a spawned sprite with no MAIN handler, or one that draws nothing,
  shows the marker with the reason.
- `map-sprites.ts` (`launcherResult`) turns the torpedo's and the arm's OAM entries into one
  bitmap anchored at the shooter.
- Routine bytes (both routines, hashed) and the call path (the loader route, the
  dispatch) are checked as for the castle flames: a difference does not blank the
  launcher (D52 option B), it is drawn from the code at the vanilla address and flagged
  `unverified`. What refuses (a spawn that finds no slot, a BRK) shows the marker with
  the reason.
- Not generalised to $C9 (the Bullet Bill shooter): its fire spawns a sprite $1C
  through `ShootBullet` (`bank_02.asm:6920`) and has a different preview question; it
  keeps the marker.

## Evidence

Vanilla USA ROM, map $011, the 19 placed $CA, one run on one machine: each gives
a verified arm (char $184, attribute $13, 16 x 16, at X + 8, Y - 9) and a torpedo at the
shooter (front tile $80 and back tile $82, priority 1, flipped only with Mario on its right) (`test/suite/unit/sprites/TorpedoLauncher.test.ts`).
