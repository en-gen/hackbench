# Initial facing in the map view: where Mario's seed comes from (#272)

A sprite that faces Mario at INIT (`JSR SubHorizPos`, `STA $157C,X`; SMWDisX `bank_01.asm:6124-6134`)
draws left or right by where Mario stands when INIT runs. The served map path
(`interpDrawer`, `theia/extension/src/node/map-sprites.ts`) seeds that Mario from the loader image's
`$94/$96` (`levelSeed`), and falls back to `readMarioStartPos` only when the loader refused.

## Why the loader's value

- It is what the ROM's own loader left, entrance nudge included (CODE_00A635's entrance-type
  adjustments, `bank_00.asm:5019-5060`, as `src/rom/MarioStartPos.ts` documents).
- `LevelStart.ts` (the #339 scroll start) skips that nudge, so it differs from the loader by 8 px X on
  45 vanilla maps. A sprite near Mario could flip on 8 px, so the map view does not use it.
- The `SpriteSeed` default (`0x80, 0x80`) is a placeholder for a run with no level.

## Evidence (vanilla cart `6b47bb75`, one machine, layers_v5 captures, 2262 records with `initFacing`)

- `SpriteInitFacing.test.ts`: loader `$94/$96` equals `readMarioStartPos` on all 512 maps.
- Records whose `marioAtInit` differs from the capture's `marioStart` (236 records on 106 maps) are
  named and excluded: INIT saw another Mario than we seed there. The earlier "62 across 34" is not
  what the capture set holds today.
- Of the other 2026, 2014 match the capture's `$157C`; 12 differ and are listed in the test
  (maps `11e`, `11f`, `126`, `1c4`, `1c5`), open and not fixed by that test file.
