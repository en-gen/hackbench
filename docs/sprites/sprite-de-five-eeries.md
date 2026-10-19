# Sprite $DE: five Wave Eeries from one placement (#1015)

How the map view draws it, and what each step rests on. Evidence scope throughout: vanilla USA ROM (the
disassembly SMWDisX), the `layers_v5` Mesen capture of map $021, one machine, 2026-10-17.

## In the game

- $DE is not a sprite. The sprite loader (`CODE_02A88C`, SMWDisX `bank_02.asm:5312-5322`) compares the list id,
  hands `Load5Eeries` the entry's screen-boundary X in `$00/$01`, its list index in `$02` and the offset of its
  first byte in `$03`, and moves on. No sprite slot is kept for $DE itself.
- `Load5Eeries` (`bank_02.asm:6269-6313`) reads that first byte through `SpriteDataPtr`: the high nibble is Y low,
  bit 0 is Y high (6270-6277). It then spawns five sprites, counting `$04` from 4 to 0:
  - each in the first free slot (`FindFreeSprSlot`, 6281), status $08, number $39, `InitSpriteTables` (6284-6288);
    **no INIT runs**, so `InitEerie` (`bank_01.asm:16195`) never touches them;
  - X = `$00/$01` + `EerieGroupDispXLo/Hi[$04]` (-32, -16, 0, 16, 32 px; tables at 6254-6258), Y from the data byte;
  - Y speed `EerieGroupSpeedY` (two values alternating) and state `EerieGroupState` (0 and 1) (6260-6264, 6301-6304);
  - X speed `EerieGroupSpeedX[Y]`, where `SubHorzPosBnk2` (`bank_02.asm:524-534`) has just set Y to 1 when Mario is left
    of the sprite and 0 otherwise (6309-6311). Two table entries because Y is only ever 0 or 1.
- Only the first spawn (offset +32) gets `SpriteLoadIndex = $02` (6305-6308).
- Room: `FindFreeSlotRt` searches the map's slot range from `SpriteSlotMax` down and never tests `SpriteSlotStart`
  itself (`bank_02.asm:5523-5539`; tables 5182-5200). The loop stops at the first call with no free slot (6281-6282).
  Memory setting 11 (maps $11D, $1E8, $1E9) is the range 4..1, so from empty slots **four** Eeries spawn and the
  last of the five (-32) never exists. Map $021 is setting 17 (range 5..0, start $FF), five spawn.
- The Eerie ($39, `bank_01.asm:16211-16241`) then moves each frame: X by its speed, Y by `DATA_01EBB4[C2 & 1]`
  added to the Y speed until it hits $18 or $E8 (C2 flips), so the five bob up and down out of step.

## What the capture shows (map $021)

- The recording is mid-play, not at the map's start: the Eeries load when the camera reaches them (spawn frames 1139 and
  1389, camera X 728 and 2248). Nothing about $DE exists at the map-start frame.
- Per placement the capture holds ONE record, labelled $39, `initFrame` null (list 4 and list 15, slot 4). Not
  five, and not "off screen": all five X positions lie inside the camera. The recorder links a slot to a list entry
  through `SpriteLoadIndex`, and only the first spawn carries it (above). So only the +32 Eerie of each placement has a
  hardware record; the other four are known from the ROM routine alone. (Inference from the routine and the numbers; the
  recorder's own code was not read.) The third record counted in `grader-triage.md` is $11D's.
- List 4: x 968, y 346 at the first recorded frame (8 frames after the spawn), tile $ED; 8 frames later x 960, y 352,
  tile $6A. List 15: x 2488, y 282 (the same offsets from its entry, 2464 and Y 272).

## What it did before

A 16 x 16 marker with the digits "DE" and the reason "refused: INIT: id $de is past the 201-entry pointer table" at
the placement, on all five placements. The reference VS Code extension has no handling of $DE at all.

## In the editor

- `src/rom/sprites/interp/FiveEeries.ts` runs `Load5Eeries` on the core (`SpawnRun.routine`, JSR with DB 2) over the
  map's own loaded state, with the caller's inputs in `$00-$03`, and draws the n-th spawned sprite alone with the ordinary
  sprite runner (`SpawnRun.nth`, counted in the order the spawn filled its slots, so nth 0 is the first spawn, the one that carries the list index), five times. Nothing about a position, speed or frame is written there. A
  spawned sprite that is not picked is emptied for that run so the five do not add to each other's OAM.
- Map view (`map-sprites.ts`, `eeriesResult`): ONE sprite at the entry's stream index whose parts are the Eeries,
  anchored at the entry. In a vertical map the loader hands the spawner the scroll-axis boundary, the
  entry's Y, as its X (`bank_02.asm:5232-5238`), and the spawner reads the entry's first byte as the Eerie's Y. It is run on
  those inputs and drawn, with `unverified` saying so: no vanilla placement is in a vertical map, so that input is
  derived from the loader and not checked (D52: drawn, not blanked). A synthetic cart pins the arithmetic.
- The spawner that runs is the one the loader's `JSR` names (the operand at $02:A895, what the ROM holds), so a hack that
  repoints the call runs its own routine; with no `JSR` there the vanilla entry runs. Either way the route is flagged.
- Gate (BA fingerprint ruling, 2026-10-18: one SHA-256 only over 24 or more unknown bytes). (1) The spawner that runs is
  hashed: one SHA-256 over 97 bytes, about 96 unknown. A difference is named in `unverified` and it still runs. (2) The
  loader route at $02:A88C is 12 bytes, too few to hash, so it is checked by structure: every instruction from the
  compare to the call, CMP #$DE, BNE, PHY, PHX, DEY, STY $03 and JSR, each compared alone against a named constant
  (`eeriesRouteIntact`). Only the BNE's offset is not read. A route that is not this shape REFUSES with a plain-words
  reason before the JSR is read: a BRA between the compare and the call can skip a JSR whose bytes are still there, and a
  rewritten loader may hold $20 as an operand where the JSR was. A repointed JSR operand on an intact route still runs the
  spawner it names, and is flagged when that spawner differs. (3) SubHorzPosBnk2 is not checked on its own: the spawner run
  executes it, so the Eeries face as the ROM's routine makes them, and nothing about it is hashed or stated. The tables
  are data and are not hashed. What refuses: no map image, a changed loader route, no JSR, a spawner that does not return
  (the reason is the core's), no Eerie drew. A refusal is a marker with the reason, never nothing.
- Fewer than five spawned is the game's own answer, so it is not `unverified`. The sprite carries a plain-words `note`
  ("Only 4 of the 5 Eeries appear: this map's sprite memory setting leaves room for 4.") that the map's note line shows once
  per distinct line. When the spawner itself differs from vanilla the reason is dropped ("Only 4 of the 5 Eeries appear."),
  because a changed spawner may spawn fewer for its own reasons. With no room at all the sprite is a marker reading
  "None of the 5 Eeries appear: this map's sprite memory setting leaves no room." (never nothing, D52). The synthetic cart sweeps room for 0 to 6 slots through the real path.

## Frame policy (PROP calls A, B, C, recorded for the owner)

- A. $DE draws as ONE sprite at its stream index whose parts are the five Eeries (hover later: "Five Eeries", #981).
- B. The map view shows the spawn state: the runner's first drawing pass, Mario at the map start (his side decides
  each Eerie's X speed and so its facing). The capture is not at the map start, so the corpus test compares the one linked
  Eerie after the same number of frames, below. The other four are ROM-derived only.
- C. Acceptance 1 ("positions and frame the capture shows") is met for the capture-linked Eerie of each placement;
  the capture cannot say more, for the reason above.

A sprite the spawner leaves in status $08 has no INIT, so the runner steps no frame before pass 0 (it takes the status
from the picked slot after the spawn): pass k is k + 1 frames after the spawn frame as the capture counts them. On the
linked Eerie of list 4 the run gives, at pass 7 (8 frames) x 968, y 346, tile $ED, and at pass 15
(16 frames) x 960, y 352, tile $6A: both the capture's, to the pixel and the tile
(`test/suite/unit/sprites/FiveEeries.corpus.test.ts`, both placements of $021).

D137 (owner ruled A, 2026-10-18): the map view draws each Eerie where the spawner put it, with no travel. The runner
records the picked sprite's position right after the spawn code (`SpriteModel.spawnPos`); `fiveEeries` keeps each drawn
part's offset from the Eerie as drawn and puts the Eerie back on that spot. The Eerie moves before it draws
(`bank_01.asm:16211-16241`, SubSprXPosNoGrvty / SubSprYPosNoGrvty, then SubSprGfx2Entry1), so the drawn pass would sit 2 px
left and 2 or 3 px off the data byte's Y. The first drawing pass is now at -32, -16, 0, 16, 32 px from the entry and the
data byte's Y. The synthetic fixture (`eeries.travel`) has an Eerie that moves 3 px right and 5 px down a frame;
`FiveEeries.test.ts` asserts it is drawn exactly as the fixture that does not move, and that a planted travel frame turns
that red.

## Vanilla sweep (every map that places $DE; the map view's reply, one machine)

| Map  | List entry (index, x, y)           | Eeries spawned | Drawn | Box (x0,y0 to x1,y1) | Unverified |
| ---- | ---------------------------------- | -------------- | ----- | -------------------- | ---------- |
| $021 | 4, 944, 336                        | 5              | yes   | 912,336 to 992,352   | none       |
| $021 | 15, 2464, 272                      | 5              | yes   | 2432,272 to 2512,288 | none       |
| $11D | 16, 1568, 208                      | 4              | yes   | 1552,208 to 1616,224 | none       |
| $1E8 | 16, 1568, 208 (shares $11D's list) | 4              | yes   | 1552,208 to 1616,224 | none       |
| $1E9 | 16, 1568, 208 (shares $11D's list) | 4              | yes   | 1552,208 to 1616,224 | none       |

$1E8 and $1E9 start Mario to the right of the entry, so their Eeries face right; with no travel (D137) the box
is the same as $11D's.

## Not covered

- Eeries that other live sprites would crowd out of the slot range in play: the map view starts from empty slots.
- The remaining four Eeries of a placement against hardware (no record exists).
- A hack that changes the Eerie sprite itself ($39): the ordinary runner checks apply; the loader gate above covers the
  spawner only.
