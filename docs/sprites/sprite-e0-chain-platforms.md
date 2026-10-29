# Sprite $E0: three Grey Platforms on Chain from one placement (the $E0 issue)

How the map view draws it, and what each step rests on. Evidence scope throughout: derived from the ROM's own code
(vanilla USA ROM, disassembly SMWDisX); no hardware comparison and no new capture.

## In the game

- $E0 is not a sprite. The sprite loader (`CODE_02A89C`, `bank_02.asm:5325-5331`) compares the list id, hands
  `Load3Platforms` the entry's screen-boundary X in `$00/$01`, its list index in `$02` and the offset of its first byte in
  `$03` (`$02` and `$00/$01` are set at 5240-5289), and moves on. No slot is kept for $E0 itself.
- `Load3Platforms` (`bank_02.asm:6211-6251`) reads that byte through `SpriteDataPtr`: high nibble Y low, bit 0 Y high.
  It then spawns three sprites, counting `$04` from 2 to 0, each in the first free slot (`FindFreeSprSlot`):
  - status **$01** (INIT, unlike $DE's $08), number $A3, `InitSpriteTables`, the shared X and Y;
  - `$1602` from `DATA_02AF2D` ($00, $AA, $54) and `$151C` from `DATA_02AF30` ($00, $00, $01): the three start angles
    of one ring, a third of a turn apart;
  - only the first spawn (index 2) gets `SpriteLoadIndex = $02` (6244-6247).
- INIT of $A3 is `InitGreyChainPlat` (`bank_01.asm:535-538`); its MAIN is `BanzaiBnCGrayPlat` (the pointer table entry,
  `bank_01.asm:1061`); the runner executes it, this note does not describe its drawing.

## In the editor

- `src/rom/sprites/interp/ThreePlatforms.ts` runs the spawner the loader calls (the JSR operand at `$02:A8A5`) on the
  core (`SpawnRun.routine`, `SpawnRun.nth`, as for $DE, FiveEeries.ts) and draws the nth spawned $A3 alone, three times.
  The $A3 runs its INIT first because its status is 1. No position, angle or chain tile is written there.
- Map view (`map-sprites.ts`, `platformsResult`): ONE sprite at the entry's stream index whose parts are the three
  platforms and their chains. A vertical map is drawn flagged `unverified`, as for $DE (the loader hands the spawner the Y
  boundary as X there, and the parts are re-anchored to the entry's own position); none of the vanilla placements is in one.
  A spawned child whose sprite number is not $A3 is refused, not drawn as $A3. Platforms an edited spawner makes beyond three are drawn too (up to the 12 slots) and told in the note.
- Spawn-frame positions (D137, no travel): each platform is drawn with SpriteLock (`$9D`) set, so its own MAIN
  (`Banzai_Rotating`, `bank_02.asm:11365`) skips the angle step of `CODE_02D62A` (11382-11400, `BNE CODE_02D653` at 11383) and
  draws the angle the spawner stored. Nothing is moved or zeroed by the editor. Without it the angle steps by 2 in a direction
  set by bit 4 of the X, so placements 16 px apart differed by about 1 px per platform.
- Gate (D52, never blank): ONE SHA-256 of the 84-byte spawner (`$02:AF33`, vanilla `1d4bd457...513d`, nothing masked, well
  over the 24 unknown byte minimum). The loader route at `$02:A89C` is too short to hash, so it is checked by structure, every instruction from the compare to the next case: the compare and its immediate (the sprite's own id), the `BNE` (its offset must land on the next case), the pushes with the pops in reverse order, `DEY`, the `STY $03` that hands over the data offset, the `JSR` (its operand is read as the spawner's address), the `BRA` (its offset must land on the loop head) and the next case's compare. The two compares that lead to it are checked the same way (`CMP #$E7 / BCC` at `$02:A866` landing on the $DE case, `CMP #$DE / BNE` at `$02:A88C` landing on the route); the sprite-list walk before `$02:A866` is NOT checked. A route that is not that shape refuses before any spawner runs. A difference is named in `unverified` and the
  spawner the loader calls still runs. What
  refuses: no map image, a spawner that does not return, no platform drew, no room for any (told in plain words). Platforms
  that spawned and did not draw are in the sprite's note, not in `unverified`. The two angle tables are data and are not hashed.

## Vanilla sweep (maps $000-$1FF through the map view; one machine)

| Map  | $E0 placements | Drawn | Before this change |
| ---- | -------------- | ----- | ------------------ |
| $005 | 8              | 8     | 8 placeholders     |
| $135 | 7              | 7     | 7 placeholders     |

No other map places $E0. Each placement's group box is 131 px wide and 89 or 90 tall (chains and platforms), against 16 x 16
for the placeholder. $135 placements are at (368,240), (768,192), (1712,176), (2112,320), (3056,176), (3888,160),
(4496,208). The 24 directly placed $A3 (22 on map $023, 2 on $135) have the identical map reply before and after.

## Not covered

- The platforms against hardware: no capture was taken. Which pass of their rotation the map shows is the runner's
  first drawing pass, Mario at the map start.
- Platforms other live sprites would crowd out of the slot range in play: the map view starts from empty slots.
