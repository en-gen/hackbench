# #653 Stage B, step 1: how often the interpreter refuses on the hack corpus

Acceptance step 1 of #653: before any leaf is routed through the interpreter,
report per leaf how often the differential interpreter refuses where the port
draws today. No routing changed; this is the report the owner reviews before
step 2.

**Evidence scope.** The Stage A sweep (`L1Interpret.leafSweep.corpus.test.ts`,
`sweep()` in `test/suite/support/l1Differential.ts`), run on one machine
(owner workstation, Windows 11) on 2026-10-10 at develop `9f5956e8`, over the 6
ROMs in `CORPUS` (vanilla, the Lunar Magic vanilla re-save, Seven Vanilla
Levels, Grand Poo World 2 1.1, Grand Poo World 1.2, Invictus 1.0). Each ROM
runs 241,920 standard-object cases: a fixed grid (columns 0/3/15 of screen 5,
one tileset per dispatcher), not a count of objects in real levels. "Refused"
is the interpreter declining a case; the port draws every case. Per-leaf
refusal reasons are not broken out by the sweep, only ROM-wide ones.

## Recount

The sweep's agreeing set on vanilla is 61 leaves, SHA-256 pinned in the test.
It equals the 61 addresses listed in #653 exactly (no leaf added or missing).

## Headline

| ROM | cases landing on the 61 leaves | refused | differs | agrees |
| --- | ---: | ---: | ---: | ---: |
| Super Mario World (USA), vanilla | 197,952 | 0 | 0 | 197,952 |
| Vanilla re-saved by Lunar Magic | 197,952 | 0 | 0 | 197,952 |
| Seven Vanilla Levels | 167,232 | 68,826 | 0 | 98,406 |
| Grand Poo World 2 1.1 | 0 | 0 | 0 | 0 |
| Grand Poo World 1.2 | 171,072 | 0 | 0 | 171,072 |
| Invictus 1.0 | 167,232 | 0 | 0 | 167,232 |

- Agrees is cases minus refused minus differs (167,232 - 68,826 - 0 = 98,406
  for Seven Vanilla Levels); the per-leaf table's refused and case columns sum
  to the same 68,826 and 167,232. Scope: the fixed grid on one machine, as
  above; nothing here counts cases outside the 61 leaves.
- Four ROMs (vanilla, the Lunar Magic re-save, Grand Poo World 1.2, Invictus):
  the interpreter refuses 0 cases and differs on 0 cases across all 61 leaves.
- Seven Vanilla Levels: refuses 68,826 of 167,232 cases (41%), on 52 of the 61
  leaves; no leaf is refused in full. The ROM-wide dominant reason is
  a REP/SEP instruction touching flags other than M/X (84,244 of its refusals,
  counting keys outside the 61). The 9 leaves with no refusal: 0DAB0D, 0DB075, 0DB705,
  0DB966, 0DBA4C, 0DC44F, 0DCF33, 0DED6B, 0DED99.
- Grand Poo World 2 1.1: every one of 241,920 cases is refused before any leaf
  dispatch (key 000000, an opcode outside the interpreter's allowed set; the
  sweep reports only that, and this report does not claim which instruction
  the hack placed at the entry). No leaf has a single case, so routing would fall back to
  the port everywhere on this ROM.
- Differs is 0 on the 61 leaves for every ROM. Hack-specific differences exist
  only on leaves outside the 61 (for example 8,517 cases on the Magic,
  Invictus and Grand Poo World 1.2 outside keys).

## Per leaf

Each cell is `refused/differs/cases`. `none` means the ROM sent no case to the
leaf. Grand Poo World 2 has no cases on any leaf (see above).

| Leaf | vanilla | LM re-save | Seven Vanilla | GPW 2 | GPW 1.2 | Invictus |
| --- | --- | --- | --- | --- | --- | --- |
| 0DA8C3 | 0/0/53760 | 0/0/53760 | 23520/0/53760 | none | 0/0/53760 | 0/0/53760 |
| 0DAB0D | 0/0/3840 | 0/0/3840 | 0/0/3840 | none | 0/0/3840 | 0/0/3840 |
| 0DAB6E | 0/0/480 | 0/0/480 | 160/0/480 | none | 0/0/480 | 0/0/480 |
| 0DAC21 | 0/0/480 | 0/0/480 | 160/0/480 | none | 0/0/480 | 0/0/480 |
| 0DAC92 | 0/0/480 | 0/0/480 | 160/0/480 | none | 0/0/480 | 0/0/480 |
| 0DAD44 | 0/0/480 | 0/0/480 | 350/0/480 | none | 0/0/480 | 0/0/480 |
| 0DADA3 | 0/0/480 | 0/0/480 | 210/0/480 | none | 0/0/480 | 0/0/480 |
| 0DAE6D | 0/0/240 | 0/0/240 | 165/0/240 | none | 0/0/240 | 0/0/240 |
| 0DAEFC | 0/0/240 | 0/0/240 | 165/0/240 | none | 0/0/240 | 0/0/240 |
| 0DAF61 | 0/0/240 | 0/0/240 | 95/0/240 | none | 0/0/240 | 0/0/240 |
| 0DAFEA | 0/0/240 | 0/0/240 | 95/0/240 | none | 0/0/240 | 0/0/240 |
| 0DB075 | 0/0/3840 | 0/0/3840 | 0/0/3840 | none | 0/0/3840 | 0/0/3840 |
| 0DB1C8 | 0/0/3840 | 0/0/3840 | 3705/0/3840 | none | 0/0/3840 | 0/0/3840 |
| 0DB1D4 | 0/0/3840 | 0/0/3840 | 1680/0/3840 | none | 0/0/3840 | 0/0/3840 |
| 0DB336 | 0/0/3840 | 0/0/3840 | 1680/0/3840 | none | 0/0/3840 | 0/0/3840 |
| 0DB3BD | 0/0/3840 | 0/0/3840 | 1680/0/3840 | none | 0/0/3840 | 0/0/3840 |
| 0DB3E3 | 0/0/75264 | 0/0/75264 | 19488/0/44544 | none | 0/0/48384 | 0/0/44544 |
| 0DB42D | 0/0/3840 | 0/0/3840 | 1680/0/3840 | none | 0/0/3840 | 0/0/3840 |
| 0DB461 | 0/0/3840 | 0/0/3840 | 1680/0/3840 | none | 0/0/3840 | 0/0/3840 |
| 0DB6C3 | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DB705 | 0/0/768 | 0/0/768 | 0/0/768 | none | 0/0/768 | 0/0/768 |
| 0DB73F | 0/0/768 | 0/0/768 | 256/0/768 | none | 0/0/768 | 0/0/768 |
| 0DB916 | 0/0/3072 | 0/0/3072 | 1344/0/3072 | none | 0/0/3072 | 0/0/3072 |
| 0DB91E | 0/0/3072 | 0/0/3072 | 1344/0/3072 | none | 0/0/3072 | 0/0/3072 |
| 0DB966 | 0/0/768 | 0/0/768 | 0/0/768 | none | 0/0/768 | 0/0/768 |
| 0DB9C0 | 0/0/768 | 0/0/768 | 256/0/768 | none | 0/0/768 | 0/0/768 |
| 0DBA0A | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DBA4C | 0/0/768 | 0/0/768 | 0/0/768 | none | 0/0/768 | 0/0/768 |
| 0DBB2C | 0/0/768 | 0/0/768 | 256/0/768 | none | 0/0/768 | 0/0/768 |
| 0DBB63 | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DC358 | 0/0/768 | 0/0/768 | 256/0/768 | none | 0/0/768 | 0/0/768 |
| 0DC3D8 | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DC42E | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DC44F | 0/0/768 | 0/0/768 | 0/0/768 | none | 0/0/768 | 0/0/768 |
| 0DC4EF | 0/0/768 | 0/0/768 | 256/0/768 | none | 0/0/768 | 0/0/768 |
| 0DCF12 | 0/0/1536 | 0/0/1536 | 672/0/1536 | none | 0/0/1536 | 0/0/1536 |
| 0DCF33 | 0/0/1536 | 0/0/1536 | 0/0/1536 | none | 0/0/1536 | 0/0/1536 |
| 0DCF6E | 0/0/48 | 0/0/48 | 16/0/48 | none | 0/0/48 | 0/0/48 |
| 0DCFB1 | 0/0/96 | 0/0/96 | 60/0/96 | none | 0/0/96 | 0/0/96 |
| 0DCFF0 | 0/0/48 | 0/0/48 | 35/0/48 | none | 0/0/48 | 0/0/48 |
| 0DD034 | 0/0/96 | 0/0/96 | 42/0/96 | none | 0/0/96 | 0/0/96 |
| 0DD24E | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DDB06 | 0/0/192 | 0/0/192 | 64/0/192 | none | 0/0/192 | 0/0/192 |
| 0DDB8F | 0/0/192 | 0/0/192 | 64/0/192 | none | 0/0/192 | 0/0/192 |
| 0DDC02 | 0/0/192 | 0/0/192 | 140/0/192 | none | 0/0/192 | 0/0/192 |
| 0DDC61 | 0/0/192 | 0/0/192 | 84/0/192 | none | 0/0/192 | 0/0/192 |
| 0DDCA9 | 0/0/1536 | 0/0/1536 | 672/0/1536 | none | 0/0/1536 | 0/0/1536 |
| 0DDCEA | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DDD2E | 0/0/768 | 0/0/768 | 256/0/768 | none | 0/0/768 | 0/0/768 |
| 0DDD5C | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DECC9 | 0/0/1536 | 0/0/1536 | 672/0/1536 | none | 0/0/1536 | 0/0/1536 |
| 0DED6B | 0/0/768 | 0/0/768 | 0/0/768 | none | 0/0/768 | 0/0/768 |
| 0DED99 | 0/0/768 | 0/0/768 | 0/0/768 | none | 0/0/768 | 0/0/768 |
| 0DEDDB | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DEE17 | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DEE52 | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DEE89 | 0/0/768 | 0/0/768 | 368/0/768 | none | 0/0/768 | 0/0/768 |
| 0DEF67 | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DF02B | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DF066 | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
| 0DF06C | 0/0/768 | 0/0/768 | 336/0/768 | none | 0/0/768 | 0/0/768 |
## What this means for step 2

1. Leaves with refusals only on Seven Vanilla Levels would route through the
   interpreter on every other corpus ROM and fall back to the port (marked
   unverified) on Seven Vanilla Levels, per acceptance 3.
2. Grand Poo World 2 would never route; the cause is the dispatcher entry, not
   a leaf, so it is a question for the owner whether that is acceptable.
3. Nothing here measures frequency in real levels; a render-hash sweep
   (acceptance 4) is the check that routing changes no pixel.
