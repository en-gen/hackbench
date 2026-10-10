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

| | exact | shape | close | wrong | empty | graded |
| --- | --- | --- | --- | --- | --- | --- |
| #829 body, 2026-10-05 | 932 | 572 | 136 | 300 | 17 | 1,957 |
| Today, develop `9f5956e8` | 936 | 572 | 136 | 300 | 13 | 1,957 |

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

| Code | Cause | Count | Sample | Verdict |
| --- | --- | --- | --- | --- |
| G1 | Grader drops parts at OAM Y 224-255 that the capture keeps | 31 | $6C map 109 at 112,256 | grader wrong |
| A | Castle-flame cluster sprites counted as the sprite's parts | 30 | $22 map 101 at 1472,336 | runner and grader |
| B | Graded pass is the first drawing pass; no recorded frame shows that pose | 161 | $3D map 00a at 192,368 | policy |
| K | List ids $DA-$DD are stationary shells (status 9); we run a fresh walking Koopa | 35 | $05 map 135 at 3184,240 | runner wrong |
| C | Sprites spawned by INIT draw into the same run and are counted | 12 | $61 map 10a at 160,384 | runner and grader |
| H | A sprite that draws a companion found by a slot scan has none to find | 14 | $9C map 006 at 1168,272 | runner wrong |
| S | Floating-platform INIT sinks the sprite 32 px further than the capture | 9 | $A4 map 102 at 912,400 | runner wrong, mechanism open |
| U | One-pose differences, not reached in 64 passes | 8 | $37 map 1db at 864,336 | unexplained |
| T1 | Tables and interpreter each match a different recorded frame of the same cycle | 34 | $05 map 008 at 224,368 | interpreter right, no fix |
| T2 | $1F relocates itself in MAIN; the interpreter pose is the captured one | 1 | $1F map 11c at 352,336 | interpreter right, tables wrong, no fix |
| T3 | $4D draws no tile and no capture record exists | 1 | $4D map 106 at 3760,368 | unexplained |
| | **Total distinct** | **336** | | |

Of the 300 "wrong": G1 31 + A 30 + B 161 + K 35 + C 12 + H 14 + S 9 + U 8 = 300. Of the 37: T1 34 +
T2 1 + T3 1 + the one shared with B = 37. Unexplained: U 8 + T3 1 = 9.

## Evidence and fix criteria

**G1, grader band filter (31).** `passPieces` drops a part as "parked" only when its whole extent lies in OAM Y 224-255 (`oy >= 224 && oy + size <= 256`, `spriteGrade.ts:58`);
the recorder (`hackbench-validation/capture/mesen/headless_capture.lua`, the `shown` count) treats only
Y = $F0 as hidden, and the captures hold parts at Y 232 and 248, so such a part is in the capture and not in
ours. Probe: with the band filter off, 31 of 31 listed cases leave "wrong"; over all 1,957 the
chosen-pass grade moves from exact 936 / shape 572 / close 136 / wrong 300 to 960 / 575 / 140 / 269, and
none of the 1,957 gets a worse grade (31 better). Fix: the grader keeps every part whose Y is not $F0. Assert: a synthetic part at
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

**B, graded pass (161: 89 exact at a later pass, 72 shape-only).** The policy grades the first pass that
draws (`SpriteModel.chosen`, pass 0 in all 161). No recorded frame equals it, but a later pass equals one
exactly (89) or up to position (72, sprites that move: $72 41 of 72 shape cases, $09 16). The match is at pass 1
for 96, passes 2-8 for 35, pass 9 or later for 30. The capture's first complete draw is 4 or more frames after INIT
in 1,881 of 1,919 records with an `initFrame` (4: 626, 5: 390), so pass 0 is a pose hardware does not
show first; $3D (map 00a) pass 0 draws a pose in neither of its two captured frames while passes 1-3 draw a captured one. Probe of
alternative policies over all 1,957 (first drawing pass at or after N, on the probe's own part filter, so N=0 is 296 and not 300): wrong 296 (N=0), 212 (1), 185 (4); exact
938, 858, 892; shape 573, 746, 752. Fix is a policy decision (map editor shows "first drawing pass"
on purpose), so two options: grade any pass against any frame (grader-only), or move the policy
to pass N. Assert for N=4: wrong over all graded at most 190 and exact at least 880.

**K, stationary-shell list ids (35).** All 35 are $04-$07 whose list byte is $DA-$DD and whose capture
record has `initFrame` null: 38 of the 2,262 spawn records in `layers_v5` (not of the 1,957 gradable) have it null: 35 Koopa records (list ids $DA-$DC, sprites $04-$07) and 3 records labelled $39 (list id $DE, maps 021 x2 and 11d; not part of this cause). All 35 Koopa
records are wrong. The level loader sends every list id from $DA up to $E0 to status 9 (`bank_02.asm:5348-5350`) and, for the Koopa ids, makes the sprite number `id - $DA + 4`; no INIT (`SMWDisX bank_02.asm:5339-5340`, `:5348-5350`, `:5360-5373`, `:5455-5461`). The runner
seeds the number alone with status 1, so it runs a walking Koopa's INIT and draws two parts where the
capture shows one. This is a real product defect: the map draws a walking Koopa for a stationary shell.
Not run: that status 9 reproduces the captured pose. Fix: map list ids to number and status as the loader
does. Assert: map 135 $05 at 3184,240 draws one part, and the 35 graded cases leave "wrong".

**C, spawned companions counted (12).** $61 (6), $1E (5), $B9 (1): our pass has 3 or more extra parts than the
capture (which keys parts by the slot that wrote them). $61's INIT spawns three more skull sprites
(`bank_02.asm:14495-14540`, FindFreeSprSlot); the extra parts have the companions' signature. For $1E
and $B9 the same signature holds (extra parts from other slots), the spawn code was not traced. Fix:
attribute parts to the slot (OAM index range from `$15EA`, as the capture does). Assert: $61 map 10a at 160,384
returns 1 part; $1E on map 1c4 returns 2; the 12 cases grade close or better.

**H, companion absent (14).** $9C scans slots 0-9 for a $9B (Hammer Brother) and draws it on the platform
(`bank_02.asm:12114-12142`, `PutHammerBroOnPlat`). The runner runs the sprite alone, so ours has 4 parts
and the capture 8 in all 14 (maps 006, 126, 127, 1c0, 1c4, 1c5, 11e). Fix: spawn the level's neighbouring
$9B for sprites that scan for one, or record the dependency in `dependsOn`. Assert: $9C on map 006 at 1168,272
draws 8 parts equal to one captured frame.

**S, floating-platform sink (9).** $A4 on map 102 only. INIT runs the sink loop (`bank_01.asm:6815-6837`):
ours ends 32 px below the list y (anchor y 432 for a list y of 400) while the capture's first draw is at
the list y within 16 px, so the lower two parts are off screen in ours (2 parts against 4). The inputs that
stop the sink (liquid contact) were not found; water flag in the loaded image is 0. Assert: anchor
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
