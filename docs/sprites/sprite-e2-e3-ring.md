# Sprites $E2 and $E3: a ring of 10 cluster sprites (#983)

How the map view draws them, and what each step rests on. Related: #839 (cluster OAM is
never another sprite's part), #809, #894 (the castle flames use the same mechanism).
All line numbers are SMWDisX `bank_02.asm` unless a bank is named. No assembly is copied.

## In the game

- The level's sprite loader reaches `CODE_02AAC0` (5631) from `CODE_02A8C0` (5348-5355) for
  ids $E1 and up. `CMP #$E2 / BCS CODE_02AB11` (5640-5641) sends $E2 and $E3 to the ring
  spawn. These are cluster sprites, not slot sprites.
- `CODE_02AB11` (5669-5719) refuses when `BooRingIndex` is 2 or more (5670-5672), so at most
  two rings exist. It sets a step of +1 for $E2 and -1 ($FF) for $E3 (5673-5677) and walks
  cluster slots 19 down to 0 (5680-5715). Each free slot becomes type 4, with the ring's
  number, an angle-step index counting 9 down to 0, and the rotation step; only the FIRST slot
  keeps a non-zero step (5692). That same first slot also stores the ring's centre, from the
  entry's X (`$00/$01`, the loader's screen-boundary match, 5241-5249, 5278-5281) and its Y
  byte (low nibble cleared, bit 0 the high byte), its load index, and a clear Offscreen flag
  (5693-5710). `BooRingIndex` goes up once (5717).
- The cluster loop (15950-15958) calls the type-4 entry of the dispatch table (15962-15972),
  `CODE_02FA98` (16290-16429), per slot:
  - Rotation and the offscreen test run only for the slot with the non-zero step, and not
    under SpriteLock (16297-16330): the 9-bit ring angle moves by the step per frame (512
    frames a turn); a centre more than 128 px left of or 384 px right of the camera marks the
    ring offscreen, frees its list entry for the loader (16328) and drops `BooRingIndex`.
    Every other slot then erases itself (16292-16295).
  - Position, for every slot, every frame (16331-16421): the angle is the slot's step index
    times 40 (`DATA_02FA84/85`, 16282-16288) plus the ring angle, in 512ths of a turn. The
    offset is the sine table `CircleCoords` (bank_07.asm:1012) scaled to a radius of 80 px,
    X from the sine and Y from the cosine (the angle plus 128). So the 10 pieces are 28.125
    degrees apart and cover an open arc of about 253 degrees, not a closed circle.
  - Drawing: `CODE_02FC8D` (16531-16569) and `CODE_02FD48` (16627-16686). One 16 x 16
    OAM entry per slot at the OBJ index from `DATA_02FF50` (16907-16910): slots 19..10 are
    OAM 76..85. Position is the piece's map position minus Layer 1, one byte each; the tile
    is `BooRingTiles[(slot & 3) * 2 + ((EffFrame >> 3) & 1)]` (16438-16439), the attribute
    is OBJ priority 3, palette bits 001 (CGRAM row 9), name table 1, x-flipped (`$73`).
  - Contact with Mario runs every 4th frame (`CODE_02FBB0`, `CODE_02FE71`, 16781-16821).
- Direction, on screen with Y down: the angle zero point is below the centre and 128 is to
  the right, so an increasing angle ($E2) turns counter-clockwise and a decreasing one ($E3)
  clockwise.

## In the editor

- `src/rom/sprites/interp/RotatingRing.ts` runs the spawn and the draw on the 65816 core over
  the level's own state (`levelSeed`), as `CastleFlames.ts` does for $E6. Nothing is a table in
  the editor: positions, tiles and attributes are read from the OAM the routines wrote.
- Per ring entry, on a fresh machine (each ring is drawn alone, owner call C): the entry's
  X, list index and stream offset are put where the loader leaves them, the camera is put on
  the centre so all 10 pieces are on screen, SpriteLock is set, Mario is put far away (the
  contact test then misses; owner call F), the ring angle is 0 (the value the level load
  leaves; owner call A), the spawn runs with the id in A, then the draw once per type-4 slot.
  Pieces come back from OAM into map pixels through the camera.
- Frame policy: SpriteLock is set, so the ring does not turn; the map shows the spawn
  state, angle 0. The first ring met on a level starts there; a later one starts wherever the
  last ring's turning left `BooRingAngle`, which the editor does not model.
- `map-sprites.ts` (`interpDrawer`) answers $E2/$E3 from this module: ONE sprite per stream
  entry at its real index, with the 10 pieces as its parts (so hover and selection key on the
  entry, #981), over the normal OAM priority planes (priority 3).
- A routine or call-path part that is not the vanilla shape does not blank the ring (owner
  ruling D52, option B): the ring is drawn from the code as it stands and the sprite is flagged
  `unverified`, naming the part (the spawn, the draw, the two draw helpers, the loader route, the
  cluster spawn entry, the $E2/$E3 branch, the cluster loop, the dispatch call and its target,
  the type-4 dispatch entry). Fingerprints cover the routines only, not the data tables. What
  still keeps the marker, with its reason: no level image, a run that does not return or leaves
  ROM, a vertical level (owner call B: the loader hands the spawn the screen's Y boundary as the
  ring's X there, 5232-5238, so the ROM's own ring would be at the wrong place), the extra-bits
  flag, and chars that are not loaded.
- The names in `SpriteMetadata.ts` now say what the code does: "Rotating ring of 10,
  counter-clockwise" ($E2) and "Rotating ring of 10, clockwise" ($E3). The graphic is not
  claimed to be a Boo: only the disassembly's labels say so.

## Evidence scope

- Vanilla USA ROM, one machine, 2026-10-16. Mesen frames `layers_v5/107/windows/screen_01` (camera
  256, frame 1077) and `screen_02` (camera 512, frame 1119): OAM 76-85 hold the ring of the first
  $E3 (496, 320), 16 x 16, attribute `$73`. The ROM-run ring equals those frames in position, tile,
  attribute and size, 10 of 10 each, at ring angles 501 and 459 (42 frames apart, 42 less: the
  $E3 step is -1 a frame); the angles are fitted, so what is pinned is the shape and the step,
  not the angle of the map view. `RotatingRing.test.ts`, corpus-gated.
- Placements drawn, all verified (no `unverified`): $E3 on $013, $0EC, $0EE, $107, $1FB; $E2 on
  $0ED, $0F2, $0F8, $107, $1FB; each 10 pieces at 80 px (to 1.5 px) and 28.125 degrees
  (to 2 degrees). Only $107 has hardware frames; the others are not captured.
- Not modelled: the turning (the map holds angle 0), the animation (EffFrame selects the
  tile; the map shows the image's frame), the contact test, a second simultaneous ring, a
  ring's angle after earlier rings, and any ring in a vertical level.
