# Sprite grader triage: why 300 sprites grade "wrong" (#829)

Investigation, no code changed. Per-case identifiers:
[grader-triage-cases.md](grader-triage-cases.md).

## Evidence scope

- Machine: one Windows 11 box, Node 26.3.1, Vitest 5.0.3. Date 2026-10-10.
- Code: develop at `9f5956e8` (the grader is `test/suite/unit/sprites/spriteGrade.captures.test.ts`
  with `test/suite/support/spriteGrade.ts`, unmodified).
- ROM: the vanilla cart only (SHA-1 prefix `6b47bb75`). Captures: `layers_v5`
  `sprite_spawns.json`, 164 zips, 1,957 gradable sprite records.
- Method: the grader's own run reproduces the grade; a throwaway probe (scratchpad, not
  committed) re-ran the 300 wrong sprites for 64 passes and dumped per-pass parts as numbers, then
  causes were derived by rule (below) and checked against SMWDisX. Nothing was hand-labelled
  per row. No hardware other than the recorded captures; no emulator re-run. No ROM bytes are in this file.
- Owner ticks from the sprite report (#828): none available (issue open, no report published).

## Reproduced grade

|                           | exact | shape | close | wrong | empty | graded |
| ------------------------- | ----- | ----- | ----- | ----- | ----- | ------ |
| #829 body, 2026-10-05     | 932   | 572   | 136   | 300   | 17    | 1,957  |
| Today, develop `9f5956e8` | 936   | 572   | 136   | 300   | 13    | 1,957  |

Wrong is the same 300; exact and empty improved by 4 each since 2026-10-05.

## Method

Each case gets the FIRST cause in this list whose fix, applied on top of the earlier ones, takes
the chosen pass out of "wrong": G1, then A, then B; the rest are grouped by the numbers
(sprite id, part counts, anchor and capture position, `initFrame`, OAM indices). A case that
needs two fixes carries the earlier one. The 37 rows of the #829 comment were checked against
the captures by re-running the table engine and the interpreter as `MapSpritesInterp.test.ts` does
and converting each capture frame to the same part keys. One row (map 11b, $03 at 144,368) is in
both lists: 336 distinct cases from 337 listed.

## Causes

| Code | Cause                                                                           | Count   | Sample                  | Verdict                                 |
| ---- | ------------------------------------------------------------------------------- | ------- | ----------------------- | --------------------------------------- |
| G1   | Grader drops parts at OAM Y 224-255 that the capture keeps                      | 31      | $6C map 109 at 112,256  | grader wrong                            |
| A    | Castle-flame cluster sprites counted as the sprite's parts                      | 30      | $22 map 101 at 1472,336 | runner and grader                       |
| B    | Graded pass is the first drawing pass; no recorded frame shows that pose        | 161     | $3D map 00a at 192,368  | policy                                  |
| K    | List ids $DA-$DD are stationary shells (status 9); we run a fresh walking Koopa | 35      | $05 map 135 at 3184,240 | runner wrong                            |
| C    | Sprites spawned by INIT draw into the same run and are counted                  | 12      | $61 map 10a at 160,384  | runner and grader                       |
| H    | A sprite that draws a companion found by a slot scan has none to find           | 14      | $9C map 006 at 1168,272 | runner wrong                            |
| S    | Floating-platform INIT sinks the sprite 32 px further than the capture          | 9       | $A4 map 102 at 912,400  | runner wrong, mechanism open            |
| U    | One-pose differences, not reached in 64 passes                                  | 8       | $37 map 1db at 864,336  | unexplained                             |
| T1   | Tables and interpreter each match a different recorded frame of the same cycle  | 34      | $05 map 008 at 224,368  | interpreter right, no fix               |
| T2   | $1F relocates itself in MAIN; the interpreter pose is the captured one          | 1       | $1F map 11c at 352,336  | interpreter right, tables wrong, no fix |
| T3   | $4D draws no tile and no capture record exists                                  | 1       | $4D map 106 at 3760,368 | unexplained                             |
|      | **Total distinct**                                                              | **336** |                         |                                         |

Of the 300 "wrong": G1 31 + A 30 + B 161 + K 35 + C 12 + H 14 + S 9 + U 8 = 300. Of the 37: T1 34 +
T2 1 + T3 1 + the one shared with B = 37. Unexplained: U 8 + T3 1 = 9.

## Evidence and fix criteria

**G1, grader band filter (31).** `passPieces` drops a part as "parked" only when its whole extent lies in OAM Y 224-255 (`oy >= 224 && oy + size <= 256`, `spriteGrade.ts:58`);
the recorder (`hackbench-validation/capture/mesen/headless_capture.lua`, the `shown` count) treats only
Y = $F0 as hidden, and the captures hold parts at Y 232 and 248, so such a part is in the capture and not in
ours. Probe (an earlier baseline than the #838 result below, before #844 moved the grading pass): with the band filter off, 31 of 31 listed cases leave "wrong"; over all 1,957 the
chosen-pass grade moves from exact 936 / shape 572 / close 136 / wrong 300 to 960 / 575 / 140 / 269, and
none of the 1,957 gets a worse grade (31 better). **Fixed by #838** (`passPieces` and the render's `framePieces` now drop only Y = $F0; chosen-pass grade on the 1,957 moved from exact 969 / shape 792 / close 19 / wrong 164 / empty 13 to 995 / 805 / 19 / 125 / 13: 26 wrong to exact, 13 wrong to shape, none worse; one machine, hackbench-tools corpus of 2026-10-10).
Original fix text: the grader keeps every part whose Y is not $F0. Assert: a synthetic part at
OAM Y 248 is kept; the 31 listed cases grade no worse than close; wrong falls to 269 or lower.

**A, castle-flame cluster sprites (30).** Our chosen pass carries OAM entries 124-127 (four large
parts 64 px apart, the flame palette) in 27 cases; the three $33 cases on map 1d4 are the reverse: the
capture's only pieces are flame pieces, so no sprite of the record is in it. The writer is the cluster
handler at `$02:FA4E` (CODE_02FA16, `SMWDisX bank_02.asm:16224-16260`, label `CastleFlameTiles`):
the runner clears the 12 normal sprite slots (`SpriteRunner.load`) but not the cluster table the level
loader filled, and the capture itself holds one moving flame piece in some of these records. Fix: the
runner zeroes cluster sprites in `load`, and the grader drops flame pieces from both sides until it
attributes by slot (C). Assert: the part list for $33 at map 1d4 416,240 has no OAM index 124-127; the
30 listed cases grade close or better.

**A, measured after the grader cleared the loaded cluster cells (#980).** The grader seed now clears `$18B8` and
`$1892-$18A5` as `levelSeed` does (#809). Chosen-pass totals over the 1,957 records ('rom' seed, hardware timeline;
one machine, one run each, commit 17dbd4d0): before exact 998 / shape 803 / close 18 / wrong 125 / empty 13 / missAtK
25, after exact 1018 / shape 810 / close 18 / wrong 97 / empty 14 / missAtK 29. Of the 28 records that changed: map
101 14 wrong to exact, 1d4 5 and 1cd 1 wrong to exact, 01f `$67` 7 wrong to shape, and one wrong to empty (map 101 `$54`
slot 0, whose only recorded tile is OAM entry 124, a castle-flame piece, so the model drawing nothing is correct).
Pinned by `spriteGrade.captures.test.ts` (map 101 tally 14 exact / 6 wrong / 1 empty, and the raised floors) and by
`SpriteReport.test.ts` (the report grader against a mirrored loop); both go red with the clearing removed.

**B, graded pass (161: 89 exact at a later pass, 72 shape-only).** The policy grades the first pass that
draws (`SpriteModel.chosen`, the first pass with any OAM parts, `SpriteRunner.ts:526-527`; it is pass 0 in 153 of the 161, pass 4 in 5, 11 in 2, 19 in 1; the probe read the same `chosen`, so the counts stand). No recorded frame equals it, but a later pass equals one
exactly (89) or up to position (72, sprites that move: $72 41 of 72 shape cases, $09 16). The match is at pass 1
for 96, passes 2-8 for 35, pass 9 or later for 30. The capture's first complete draw is 4 or more frames after INIT
in 1,881 of 1,919 records with an `initFrame` (4: 626, 5: 390), so the first drawing pass is usually a pose hardware does not
show first; $3D (map 00a) pass 0 draws a pose in neither of its two captured frames while passes 1-3 draw a captured one. Probe of
alternative policies over all 1,957 (first drawing pass at or after N, on the probe's own part filter, so N=0 is 296 and not 300): wrong 296 (N=0), 212 (1), 185 (4); exact
938, 858, 892; shape 573, 746, 752. Fix is a policy decision (map editor shows "first drawing pass"
on purpose), so two options: grade any pass against any frame (grader-only), or move the policy
to pass N. Assert for N=4: wrong over all graded at most 190 and exact at least 880.

**K, stationary-shell list ids (35).** All 35 are $04-$07 whose list byte is $DA-$DD and whose capture
record has `initFrame` null: 38 of the 2,262 spawn records in `layers_v5` (not of the 1,957 gradable) have it null: 35 Koopa records (list ids $DA-$DC, sprites $04-$07) and 3 records labelled $39 (list id $DE, maps 021 x2 and 11d; not part of this cause: $DE spawns five Eeries and only the first carries the list index, `bank_02.asm:6305-6308`, so the recorder links one per placement; docs/sprites/sprite-de-five-eeries.md). All 35 Koopa
records are wrong. The level loader sends every list id from $DA up to $E0 to status 9 (`bank_02.asm:5348-5350`) and, for the Koopa ids, makes the sprite number `id - $DA + 4`; no INIT (`SMWDisX bank_02.asm:5339-5340`, `:5348-5350`, `:5360-5373`, `:5455-5461`). The runner
seeds the number alone with status 1, so it runs a walking Koopa's INIT and draws two parts where the
capture shows one. This is a real product defect: the map draws a walking Koopa for a stationary shell.
Not run: that status 9 reproduces the captured pose. Fix: map list ids to number and status as the loader
does. Assert: map 135 $05 at 3184,240 draws one part, and the 35 graded cases leave "wrong".

Fixed in #837: `src/rom/sprites/ShellSprites.ts` reads the loader's mapping from its bytes ($DA-$DD and $DF to status 9 and
number `id - $DA + 4` on the vanilla ROM; a changed opcode refuses; $DE and $E0 are not shells, `bank_02.asm:5312`, `:5325`); the runner loads those ids that
way and runs InitSpriteTables but no INIT. The special-world remap of numbers 4 and 5 (`bank_02.asm:5464-5471`)
is not applied: the flag is read as clear, as on a fresh save. The grader hands the runner the placed list id
(sprites.json, by `listIndex`) because a record's own id is the already-converted number. Evidence scope: one
machine, 2026-10-16, vanilla ROM, layers_v5: all 35 K cases grade exact (exact 998 to 1033, wrong 125 to 90,
nothing else moved).

**C, spawned companions counted (12).** $61 (6), $1E (5), $B9 (1): our pass has 3 or more extra parts than the
capture (which keys parts by the slot that wrote them). $61's INIT spawns three more skull sprites
(`bank_02.asm:14495-14540`, FindFreeSprSlot); the extra parts have the companions' signature. For $1E
and $B9 the same signature holds (extra parts from other slots), the spawn code was not traced. Fix:
attribute parts to the slot (OAM index range from `$15EA`, as the capture does). Assert: $61 map 10a at 160,384
returns 1 part; $1E on map 1c4 returns 2; the 12 cases grade close or better.

Traced and fixed (#840). The leak was `Machine.writtenOam()` counting every OAM tile byte written during the
pass, by any code. The game's sprite loop stores the slot it is on in `$15E9` before running it
(`SMWDisX bank_01.asm:110-125`, `STX CurSpriteProcess` at 123) and each slot's OAM index comes from its own slot
(`bank_01.asm:143-152`), so a write made while `$15E9` names another slot is that slot's. The runner now keeps a
write as the sprite's own part only when `$15E9` equals the sprite's slot, on every pass and in a neighbor run alike
(#841's neighbor run already did; the plain run's "any write" rule is gone).

- $61: INIT (`CODE_02ED8A`, `bank_02.asm:14503-14534`) spawns up to 3 more $61 (status 8, `SpriteNumber,Y`), which
  draw themselves in their own slots (`CODE_02EDD8`, `bank_02.asm:14544-14573`). Map 10a at 160,384 gives 1 part and
  3 companions.
- $1E: INIT (`InitLakitu`, `bank_01.asm:687-729`) spawns one $87 Lakitu cloud, which draws in its own slot
  (`LakituCloudGfx`, `bank_01.asm:14115`). Map 1c4 at 1120,224 gives 2 parts and 5 companions. Same cause as $61.
  (Probe, one machine, 2026-10-17: the extra writes on $1E were under slots holding $87 and $14.)
- $B9 is not the same cause: its INIT is a bare RTS (`Return0185C2`, `bank_01.asm:890`, the shared `RTS` after
  `InitPiranha`) and it spawns nothing. Its two wrong records (map 004 at 144,336 "model drew 21", map 101 at 96,336
  and 1840,336 "model drew 5") were OAM written under `$15E9` values 0-19 by the cluster sprite loop: `CODE_02F810`
  does `LDX #$13` / `STX $15E9` (`bank_02.asm:15950-15958`), and it is reached from the runner's own frame through
  `ActivateClusterSprite` -> `JSL CODE_02F808` (`bank_01.asm:128-130`). The writing PCs (one machine, 2026-10-17
  probe) are `$02:FD76` on map 004 and `$02:FA4E` on map 101. Traced from the nearest preceding label (offset in
  bytes): `$02:FD76` is `CODE_02FD48` +46, the Boo ring's tile store (`STA OAMTileNo+$100,Y` after `BooRingTiles`,
  `bank_02.asm:16651`); `$02:FA4E` is `CODE_02FA16` +56, the castle flame's tile store (`bank_02.asm:16255`). $B9's own
  tiles are written under its own sprite slot (PCs `$01:9F2A`, `CODE_019E95` +149, `bank_01.asm:4083`, and `$03:8DB4`,
  `DATA_038D66` +78, `bank_03.asm:1698`; for these two only the label and offset were taken from the disassembly
  index, the exact instruction line was not traced). Whether the own-slot rule acts on $B9 was NOT shown by a test: on
  develop at `a028e0dc` the 101 records already grade exact, and a plain map-view run of $B9 on 101 (4 spots) gives 1
  part and 0 companions, so no write under another `$15E9` reached an OAM tile byte at those seeds. The map 004 claim
  that $B9 sits in sprite slot 6 and so keeps cluster index 6's write is an inference from the probe PCs, not
  reproduced here; read its "close" grade as unverified. The synthetic id 84 (`$15E9` set to 15) is the real
  other-slot write under test.
- $2B's former spawn-oracle extra tile was also a cluster write (`$02:F983`, `$15E9` = 9; `CODE_02F967` +28, the Sumo
  Bro flame tile store, `bank_02.asm:16145`), now filtered.
- The map view still draws companions (owner principle D52: "We can't outright hide things from the user").
  `PassResult.companions` is, in a plain run, every tile write made under a `$15E9` other than the sprite's own
  (a sprite this run spawned, a cluster index, Yoshi's OAM), so parts plus companions are exactly what the map view
  drew before #840. A neighbor run (#841) keeps none: its picture was the sprite's own writes alone. A tile byte belongs
  to the last slot that wrote it, so a reused OAM tile is decoded once. `drawnParts` is `parts` plus `companions`: the
  chosen pass, the "drew no tile" test, `modelResult`, the pose frames, the screen-fixed pass and the spawn readers
  (`SpawnedChildren`, `FiveEeries`) use it, so a spawner that draws only through its companions still draws. The grader
  and sprite report read `parts` only. A write under a `$15E9` that names no spawned slot (id 84 in the synthetic
  cart) is a companion, never a part, unless the value equals the sprite's own slot.
- Ownership rule (`Machine.own` / `Machine.companion`): the game's sprite loop stores the slot it is on in `$15E9`
  before running it (`bank_01.asm:110-125`) and each slot takes its OAM index from itself (`bank_01.asm:143-152`), so a
  tile write made under another slot is that slot's. `own` is the writes under the sprite's slot (the grader's parts);
  `companion` is every other write in a plain run, so `own` plus `companion` equals what the map view drew before #840.
- Remaining limit: a cluster sprite whose index equals the sprite's slot (the loop at `bank_02.asm:15950-15958`), and
  Yoshi's OAM (it sets `$15E9` at `bank_01.asm:14344`; `CODE_01C9E2` restores the caller's at 10051), run under
  another `$15E9` and are still credited to the sprite when the index matches. Not a regression (the old code credited
  all of it); the cluster OAM leak work (#809) was the follow-up; Corrected 2026-11-07: was "the follow-up", because #809 closed with #849 (`6773d8e1`), which stopped a level's cluster sprites drawing into the sprite under test.

Grader, `spriteGrade.captures.test.ts` (1957 records, 'rom' seed, vanilla ROM, `layers_v5`, one machine, measured
2026-11-05): develop `05d062f7` exact 1906, close 17, wrong 33, empty 1; the #840 branch head `33ceb3b6` exact
1917, close 17, wrong 22, empty 1; the same counts re-run at `a275ae3f`. 11 records improved from "wrong" to "exact" (6 of $61 on map 10a, 5 of $1E on maps
11f, 132, 1c4, 1c5) and none graded worse (compared record by record, same order). Spawn tier (201 ids, 16 passes,
same machine and date): develop alone 2,792 exact, 260 exact-empty, 15 wrong; merged 2,792, 275, 0 (id $2B). Map view
pictures, develop `05d062f7` against the head `33ceb3b6`: 0 of 53,415 records differ, every placed sprite on the 488 available vanilla maps plus all 256 ids at each of the 196 sprite-bearing maps' first list entry, 24 maps unavailable, one machine, 2026-11-05. (The earlier counts in this
paragraph, exact 1063 / wrong 41, were against the pre-#842 grader and are superseded.)

**H, companion absent (14).** $9C scans slots 0-9 for a $9B (Hammer Brother) and draws it on the platform
(`bank_02.asm:12118-12148`, `PutHammerBroOnPlat`; `HammerBroGfx` 12044-12091). The $9B draws nothing in its own
turn (`bank_02.asm:11964-11969` draws only at status 2), so the capture's 8 parts under the platform's slot are 4 of
the platform and 4 of the bro. The runner ran the sprite alone: 4 parts, in all 14 (maps 006, 126, 127, 1c0, 1c4,
1c5, 11e). **Fixed (#841):** a run whose own code read the number or status table at another slot while its
slot was running (`scansSlots`) is run again with the map's neighbors (`neighboursOf`: its screen and the one
each side, nearest first, at most 9, an entry with the extra bit left out, and a scanner beside one marked unverified, #1173) in the other slots, counting only OAM written under its own `$15E9`; that run
is used when it adds parts and keeps the ones the run alone had (`dependsOn: neighbours`). Measured (one machine, vanilla
cart, `spriteGrade.captures.test.ts`): base develop 6d23b7b0 against the merge head, one machine: exact 1053 to 1058, shape 810 to 819, wrong 62 to 48, close 18, empty 14, and only the 14 $9C rows changed (all better); all 14 $9C records
leave "wrong" (5 exact, 9 shape); no record graded worse. Without the "keeps
the parts it had" rule, 26 other records graded worse (sprites that scan the slots for collisions), so that rule is
load-bearing.

The neighbors the sprite drew itself (it read their `$15EA` OAM index on its own turn) are recorded in
`PassResult.drew` by list index, with the OAM entries written for each. In the map view such a sprite (the $9B) stays in
the list, flagged `drawnBy` its parent (D52): it gets no marker, its area is the tiles the parent drew for it, it can be
hit, named and selected, only through its parent (it wins the hit over its parent's bitmap, which holds the same pixels), and the view does not
paint it again. A lone $9B has no drawn pass, so any placeholder the parent drew is claimed, whatever its reason; a
sprite with extra bits keeps its marker. The group is drawn at the parent's spawn frame (D137): however far the parent
had moved from its anchor when it drew the children comes off every part of the pass. The $9C draws before it moves
(`bank_02.asm:12115-12148`), so its shift is 0 and the grades above are unchanged; a parent that moves first (synthetic
fixture in `NeighbourScan.test.ts`, swept over +x, -x, +y, -y) is the case it changes. Evidence scope: vanilla ROM maps
$006 and $126 for the claim, synthetic cart for the rest, one machine.

**S, floating-platform sink (9).** $A4 on map 102 only. INIT runs the sink loop (`bank_01.asm:6815-6837`):
ours ends 32 px below the list y (anchor y 432 for a list y of 400) while the capture's first draw is at
the list y within 16 px, so the lower two parts are off screen in ours (2 parts against 4). The inputs that
stop the sink were found in #842: the loader skipped the Layer 3 handler, see
[sprite-a4-floating-spike-ball.md](sprite-a4-floating-spike-ball.md). Assert: anchor
y of $A4 at 912,400 on map 102 is within 16 px of 400.

**U, one-pose differences (8).** $16 x2, $37 x2, $30, $28, $93, $26: same part count (or close) but one
tile or palette differs in every pass. 6 of 8 are captured 51 or more frames after INIT; their pose likely depends on
Mario's facing or a timer the seed lacks. No cause shown. T3 ($4D at 106:3760,368): no capture record
exists, so nothing grades it; the docs/sprites/sprite-4d-monty-mole.md reading (hidden until Mario is near)
fits an interpreter that draws nothing, unproven.

**T1, tables and interpreter both right (34).** In each, the table engine's pose equals one recorded
capture frame and the interpreter's pose another, in the same cycle (the cycle's two walk frames; the 16
"+1 px Y" rows are the sprite's own Y moving 1 px between those frames in the capture, e.g. 352 to 353 for
the $05 rows). Neither is wrong; no fix. **T2:** $1F's capture position is 112 px left of its list
position and only the interpreter's tile set was ever recorded; the tables were wrong. No fix.

## Draft issues (not filed)

One per code G1, A, B, K, C, H, S, U (the two "no fix" rows file nothing). Each carries the count, sample and
assertion above; K is the user-visible defect and should go first.

## Limits

- One ROM, one capture set; B's 72 shape-only cases mix pose and movement, which this probe did not separate.
- Cause order matters: a case needing two fixes shows under the first (G1, A, B).
- The `initFrame` null finding is exact for this set (38 of 2,262 spawn records); why those slots lack an INIT is read from the
  ROM, not run.
