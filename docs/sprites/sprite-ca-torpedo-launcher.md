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
  the camera's left edge, spawns a normal sprite $44 (Torpedo Ted, status 8) at the
  shooter's position (`:6861-6863`) and extended sprite $08, the launcher arm, at
  X + 8, Y - 9 with `ExtSpriteMisc176F = $90` (`:6891-6902`).
- `LauncherArm` (`bank_02.asm:3969-4003`) draws the arm: tile $84 while the counter
  is $60 or more (it spawns at $90), else $A4; attribute $13 (palette 1, priority 1);
  16 x 16.

## In the editor

- `src/rom/sprites/interp/TorpedoLauncher.ts` seeds one shooter in the level's own
  state (`levelSeed`), SpriteLock set (the arm's step is skipped, so the spawn frame
  shows, the map view's frame policy), and runs `CODE_02B3AB` and then `LauncherArm` on
  the core. The arm's OAM entry is read as written; the spawned sprite's position is
  read from its slot.
- `map-sprites.ts` (`launcherResult`) runs the ordinary sprite run for $44 at that
  position and merges the arm's parts into one bitmap anchored at the shooter.
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
shooter (`test/suite/unit/sprites/TorpedoLauncher.test.ts`).
