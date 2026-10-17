# Initial facing in the map view: where Mario's seed comes from (#272)

A sprite whose INIT faces Mario (`FaceMario`: `JSR SubHorizPos`, `TYA`, `STA $157C,X`, SMWDisX
`bank_01.asm:847-851`; SubHorizPos itself is `bank_01.asm:6124-6134`) draws left or right by where
Mario stands when INIT runs. The served map path (`interpDrawer`,
`theia/extension/src/node/map-sprites.ts`) seeds that Mario from the loader image's `$94/$96`
(`levelSeed`), and falls back to `readMarioStartPos` only when the loader refused.

## Acceptance criterion 3 is unmet by design

Issue #272's acceptance criterion 3 asks for the seed to equal the #339 start (`LevelStart.ts`). It
does not, on purpose, pending owner ruling D96. The loader's value is used because:

- It is what the ROM's own loader left, entrance-type nudge included: dispatch on
  `LevelEntranceType` in CODE_00A6CC (`bank_00.asm:4987-4990`), type 6 in CODE_00A716 (5019-5033,
  `TSB $94 #$08` and `TSB $96 #$02` at 5027-5030), types 3, 4 and 7 in CODE_00A734/CODE_00A740
  (5035-5060, `TSB $94 #$08` at 5054-5055, type 7 gated at 5037-5039). `src/rom/MarioStartPos.ts`
  reads the same nudge.
- `LevelStart.ts` skips that nudge. Of the maps `readLevelStart` can resolve it differs from the
  loader by dx -8 on 41 maps and by dx -8, dy -2 (the type-6 Y nudge) on 4; 301 maps are not
  resolvable by `readLevelStart`. A sprite within 8 px of Mario could flip on that.
- The `SpriteSeed` default (`0x80, 0x80`) is a placeholder for a run with no level.

## Evidence (vanilla ROM `6b47bb75`, one machine, layers_v5 captures, 2262 records)

- `SpriteInitFacing.test.ts`: loader `$94/$96` equals `readMarioStartPos` on all 512 maps.
- The comparison seeds Mario from the loader image per map (the map view's seed), with the
  capture's slot and camera. The slot is the hardware's.
- 38 records have no INIT caught (`initFacing` null): listed, not compared.
- 62 records on 34 maps have Mario at INIT on the other side of the sprite from `marioStart`
  (the issue's set): named and excluded.
- The other 2162 are compared: 2149 match the capture's `$157C`, 13 differ and are listed in the
  test (maps `11e`, `11f`, `126`, `132`, `1c4`, `1c5`).

## Open items (follow-ups, not fixed here)

- The 9 Koopa/Goomba-type mismatches on `11e` and `126` look like a capture artefact. Hypothesis, not
  confirmed: the capture reads `$157C` after same-frame sprite code has run. Evidence scope:
  `headless_capture.lua` (en-gen/hackbench-validation, `capture/mesen`, lines ~1324 and ~1771) reads
  `$157C` at the end of the INIT frame; no write breakpoint has confirmed a later write.
- The 4 Lakitu rider (`$1E`) mismatches (`11f`, `132`, `1c4`, `1c5`) depend on the cloud's slot:
  the cloud's MAIN (`bank_01.asm:14216-14222`) writes the rider's `$157C`.
