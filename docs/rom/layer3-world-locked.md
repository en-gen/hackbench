# Layer 3 on the world-locked path (settings byte $81-$BF)

Scope: Layer 3 on a horizontal map whose Layer 3 settings byte is $81-$BF on a tileset other than
Castle1 or Underground1 (vanilla: maps $011, $130, $1C1 on tileset 9, plus $018 on tileset 13).
Evidence: static trace of SMWDisX plus the `layers_v5` captures of $011, $130 and $1C1 at frames 0, 1,
9 and 17; vanilla ROM, one machine, 2026-10-17. Code: `src/rom/model/L3Model.ts`, `entranceCameraX`
in `src/rom/L3Loader.ts`, `drawL3Planes` in `theia/extension/src/node/map-screen.ts`.

## Where Layer3YPos ($24) comes from at load

- GM12PrepLevel runs `JSL CODE_05BE8A` and then `JSR CODE_009FB8` (bank_00.asm:4869-4870).
- CODE_05BE8A copies Layer1YPos into Layer3YPos, zeroes the X speed fields and loads Layer3ScroolDir
  from the first byte of DATA_05CA26 (bank_05.asm:4784-4798, 6231). It never writes Layer3XPos.
- CODE_009FB8 overwrites $24 on every path except one: no Layer 3 or byte >= $C0 gives $D0
  (CODE_00A012), bytes $00-$7F give the tide Y, $80 gives $D0 (CODE_00A007), $81-$BF on Castle1 or
  Underground1 gives $C0 (CODE_009FFA). Byte $81-$BF on any other tileset takes CODE_00A01F, which
  writes nothing (bank_00.asm:4139-4199). The value from CODE_05BE8A survives only there.
- That is $C0 (192) on the three maps, matching the captured $24 at every captured frame. Maps $01F,
  $1D4 and $1FC (byte $80) are not on this path.

## Per frame

CODE_05C40C runs while Layer3ScrollType is 0 (bank_05.asm:4481-4484) and Layer3TideSetting is 0.
Off Castle1 and Underground1:

- Y: CODE_05C48D sets Layer3YPos = Layer1YPos every frame (bank_05.asm:5569-5570), also under
  SpriteLock (5522-5523).
- X: a target speed of $40 (DATA_05CBEB first byte $04, shifted left 4; direction 1 keeps it
  positive) is approached by +4 per frame (DATA_05CBBB, bank_05.asm:6318, 6338), reaching it after
  16 frames; the speed is 1/256 px per frame, so the cruise is 1/4 px per frame to the right of the
  scroll, the picture moving left (drift, bank_05.asm:5546-5558). Layer3XPos then adds the signed low
  byte of Layer1DXPos, the camera's movement that frame (5559-5568).

So Layer 3 is world-locked: BG3's scroll is the camera's movement since load plus the drift. Captured
BG3HOFS is 6 at frame 17 on $1C1 (camera 652), BG3VOFS equals the camera Y.

## Load position

Layer3XPos is 0 when the layer starts following; the camera is already at its entrance X (captured $1C1:
Layer1XPos 652 with Layer3XPos 1). Tilemap column 0 therefore sits at map X = the entrance camera X.

The camera at load comes from GM11LoadLevel: CODE_00A635, LastScreenHoriz = $20, then UpdateScreenPosition
once (bank_00.asm:2650-2656, 13631-13691). Before that call CODE_00A635 zeroes $13DA-$1410
(bank_00.asm:4943-4946), so CameraScrollPlayerDir is 0 and CODE_00F8AB (bank_00.asm:13873-13895) takes
Y = $0A, DATA_00F6BF[$0A] = $0002: the +/-1 adjustment never applies on a move to the right. So the camera is
start - $8C (the right buffer: CameraMoveTrigger $80 + $0C) when Mario starts past $8C, else 0, and at most
(LastScreenHoriz - 1) << 8 = $1F00 whatever the map's length. $1C1: 792 - 140 = 652, as captured;
$011 and $130 start at 24, camera 0, as captured. `entranceCameraX` is that rule; the port
`applyCameraHorizX` indexes the same tables by scroll direction, which is right per frame but not at load.

Scope of the anchor: it holds for a DIRECT load (the overworld path, which zeroes Layer1XPos,
bank_05.asm:7170). $1C1 is a sub area entered by a screen exit from $11F; on that path GM11 first copies
the old camera into NextLayer1XPos (bank_00.asm:2645-2649), so the load camera depends on the previous
map's camera (about 675 on a static trace, 23 px from the anchor, not captured). The map view draws
$1C1 at the direct-load anchor and shows no note about this: a screen-exit entry can differ. A
secondary entrance start is not modelled either.

The camera routines, their tables, the GM11 site and the CameraMoveTrigger store ($80, which sets the $8C buffer) are fingerprinted (`ENTRANCE_CAMERA_SITES`, SHA-256
of the stock bytes, as the smash sites are): a ROM that patches them gets no anchor and the layer stays
refused. CODE_00A635's zeroing loop is not fingerprinted.

## Drawing rule

The BG3 tilemap is 64 x 64 words (BG3SC $53), so it repeats every 512 px horizontally; a horizontal
map is 432 px tall, so there is no visible vertical repeat. Row R sits at map Y R * 8. Colour math keeps
BG3: CGADSUB $24 in the captures, and the BG3-clearing TRB at CODE_00A01B is skipped (bank_00.asm:4174).

The drift is not drawn and no tooltip mentions it (owner ruling); the wire keeps a `drifts` flag for a future
map properties panel.

## Not covered

- Vertical maps: refused as before (the entry's Layer1YPos high byte is not read).
- Map $018 (mode 0E, BG3 alone on the main screen, tileset 13): refused; the same code path, but its
  colour math adds BG3 onto layers 1 and 2 and the drawing is not verified against a capture.
- Settings byte $00 off Castle1 and Underground1: refused (load Y is the tide's $70, then camera-locked).
