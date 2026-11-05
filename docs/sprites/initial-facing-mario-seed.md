# Initial facing in the map view: where Mario's seed comes from (#272)

A sprite whose INIT faces Mario (`FaceMario`: `JSR SubHorizPos`, `TYA`, `STA $157C,X`, SMWDisX
`bank_01.asm:847-851`; SubHorizPos itself is `bank_01.asm:6124-6134`) draws left or right by where
Mario stands when INIT runs. The served map path (`interpDrawer`,
`theia/extension/src/node/map-sprites.ts`) seeds that Mario from the loader image's `$94/$96`
(`levelSeed`), and falls back to `readMarioStartPos` only when the loader refused.

## Acceptance criterion 3: the seed is the game loader's position (D164)

Issue #272's criterion 3 reads: on every vanilla map the seeded position equals the game loader's
Mario position, entrance nudge included. Owner ruling D164 (138C, 139A) makes the loader's value the
requirement, and it reverses D96. `SpriteInitFacing.test.ts` calls `interpDrawer` on all 512 vanilla maps and asserts the Mario it seeds the run with equals the loader image's `$94/$96`, which also equals `readMarioStartPos`'s table derivation. The value
is what the ROM's own loader left:

- The entrance-type nudge is in it: dispatch on `LevelEntranceType` in CODE_00A6CC
  (`bank_00.asm:4987-4990`), type 6 in CODE_00A716 (5019-5033, `TSB $94 #$08` and `TSB $96 #$02` at
  5027-5030), types 3, 4 and 7 in CODE_00A734/CODE_00A740 (5035-5060, `TSB $94 #$08` at 5054-5055,
  type 7 gated at 5037-5039). `src/rom/MarioStartPos.ts` reads the same nudge.
- The `SpriteSeed` default (`0x80, 0x80`) is a placeholder for a run with no map.

Factual note, not a requirement: `LevelStart.ts` (#339, the scroll target) skips that nudge. Of the
maps `readLevelStart` can resolve it differs from the loader by dx -8 on 41 maps and by dx -8, dy -2
(the type-6 Y nudge) on 4; 166 match and 301 are not resolvable. Evidence scope: vanilla ROM
`6b47bb75`, one machine, counted at develop `a028e0dc`.

## Evidence (vanilla ROM `6b47bb75`, one machine, layers_v5 captures, 2262 records)

- `SpriteInitFacing.test.ts`: the seam seed equals loader `$94/$96`, which equals `readMarioStartPos`, on all 512 maps.
- The comparison seeds Mario from the loader image per map (the map view's seed), with the
  capture's slot and camera. The slot is the hardware's.
- 38 records have no INIT caught (`initFacing` null): listed, not compared.
- 62 records on 34 maps have Mario at INIT on the other side of the sprite from `marioStart`
  (the issue's set): named and excluded. This split uses the capture's `marioStart`, which differs from
  the loader's position on 31 of the 126 capture maps; none of the 2224 records with both changes
  side of the sprite when the loader's position replaces it (reproduced here, one machine).
- The other 2162 are compared: 2158 match the capture's `$157C`, 4 differ and are listed in the
  test (the Lakitu riders on `11f`, `132`, `1c4`, `1c5`). Before #1243 it was 2149 and 13: the 9 other
  differences were a test defect (below).
- INIT runs under the id the loader placed, not the capture's id. The capture reads `$9E` at the DRAW
  (`recEndFrame`, `headless_capture.lua:1418`), while `$157C` is read at the end of the INIT frame
  (`:1771`); on `11e` slot 6 that is frame 956 against 970. An Exploding Block (`$4C`) has become another
  sprite by the draw. The key is the list id below `$C9` (`bank_02.asm:5365-5370`) and the capture's
  id from `$C9` up (`placedInitId`, `test/suite/support/gradeTimeline.ts`). Shells (`$DA`-`$DD`) get
  status 9 and no INIT (`bank_02.asm:5361`), so they never reach the comparison. Not modeled: the
  special-world remap (`5464-5471`) and the Silver P-Switch coin (`5477-5487`); neither fires in these
  captures. All 2262 records join to a list entry.
- 63 records have a capture id different from the list id: 10 placed as `$4C` (13 are placed; 3 are still `$4C` at
  the draw; the 10 became `$00` 1, `$04` 4, `$0F` 4, `$15` 1); 35 shells (`$DA` 7, `$DB` 16, `$DC` 6,
  `$DD` 6) and 3 `$DE` to `$39` (five Eeries, `bank_02.asm:5312-5318`), which are exactly the 38 records
  with no INIT; and 15 `$E0` (three chain platforms, `bank_02.asm:5325-5331`), which keep the capture's id.
  The test pins the below-`$C9` pairs, so a new one goes red.

## `$4C` (Exploding Block) facing at INIT (#1243, fixed)

The 9 Koopa/Goomba-type mismatches (8 on `11e`, 1 on `126`) were a test defect. All 9 are list id `$4C`.
Its INIT `InitExplodingBlk` (`bank_01.asm:307`, `544-554`) stores the number it will become in
`SpriteTableC2` and never calls FaceMario, so `$157C` stays 0 from `InitSpriteTables`; the block becomes
that sprite at `bank_02.asm:13281-13283`. The test had run the Koopa/Goomba INIT that the record's draw-time
id names, which gave 1.

Mesen write probe (values below are what it logged):
- Sample, map `11e` slot 6 (listX 2848): `$9E` = `$4C` and `$157C` = 0 through the INIT frame 956.
  At frame 969 `InitSpriteTables` ran with `$9E` = `$00`, then the store at `bank_02.asm:13289`
  (`STA $157C,X`) wrote 1.
- Control, slot 7 (listX 2592, Red Koopa): at INIT (frame 914) the store at `bank_01.asm:850`
  (`STA $157C,X` in FaceMario) wrote 1.
- Mario `$94`/`$D1` = 16 and `$96`/`$D3` = 368 in every logged write, so capture timing is not involved.

The other 8 records rest on the same list id and on the test, which asserts ours = 0 for each of the 10
`$4C` records that differ at the draw and checks `SpriteTableC2` against the capture's draw-time id. The
Mesen probe did not run on `126` or the other `11e` records.

Evidence scope: vanilla ROM `6b47bb75` (SHA-1 `6b47bb75d16514b6a476aa0c73a683a2a4c18765`, SHA-256
`0838e531fe22c077528febe14cb3ff7c492f1f5fa8de354192bdff7137c27f5b`), Mesen 2.1.1, hackbench-validation
`48d348c`, two probe runs on `11e` slots 6 and 7 only, one machine. SMWDisX `bank_01/MEMO.md` (`b7bda02`)
holds the finding.

## Open items (follow-ups, not fixed here)

- The 4 Lakitu rider (`$1E`) mismatches (`11f`, `132`, `1c4`, `1c5`) are not a map view defect. The map
  view draws Lakitu's facing correctly in slots 0-9 (#1007, tested: `test/suite/unit/sprites/LakituFacing.test.ts`,
  `it.each` "map $%s: pass-0 $157C follows SubHorizPos in slots 0-9, stay 0 in
  10-11"). The inferred cause is the INIT-only sampling point: the cloud's MAIN (`bank_01.asm:14216-14222`)
  writes the rider's `$157C`, and a sample right after INIT sees that only when the cloud's slot is below the
  rider's. UNTESTED inference: the capture does not record the cloud's slot. The entries stay in the test, which
  pins the INIT-time comparison.
