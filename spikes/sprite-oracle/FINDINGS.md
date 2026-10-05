# Sprite oracle: does our 65816 core run real SMW sprite routines exactly as the game does?

Status: done. Parent issue en-gen/hackbench#582. Moved here from
`hackbench-validation` (`capture/`, branch `feature/sprite-routine-oracle`,
head 711b7e3). Spike code, not product code.

## Method

1. Mesen 2.x test-runner (`mesen/sprite_routine_trace.lua`) records every call
   to HandleSprite at $01:8127: registers and WRAM in, every write out
   (SMWDisX bank_01.asm:125-126 for the loop the call returns to).
2. `oracle/compare_sprite_trace.mts` replays each call on `src/rom/cpu/Cpu65816.ts`
   (ROM read-only, recorded WRAM and Map16 seeded, multiplier/divider modelled)
   and diffs the ordered (address, value) write logs byte for byte.
3. Level mode: K=3 calls per sprite slot over 154 maps. Spawn mode
   (`mesen/sprite_spawn_extract.lua`): 201 sprite ids placed in map $0BD.
4. `oracle/plant_adc_defect.mjs` plants an ADC carry defect in a copy of the
   core to prove the comparator can go red. `oracle/render_sprite_png.mts`
   renders OAM for the owner; no images are committed.

## Results (vanilla ROM, one machine, Mesen 2.x)

| Mode  | Calls matching | OAM entries |
| ----- | -------------- | ----------- |
| level | 1122 of 1122   | 1162        |
| spawn | 3495 of 3495   | 9875        |

Planted ADC carry defect: diverges at 657 and 2538 calls. The sample was
byte-identical across 2 cold runs.

## Known gaps

- HDMA writes ($2126, $2127) and all of $2100-$21FF are dropped on both sides.
- About 11% of calls had an IRQ interrupt inside; those writes are stripped.
- 16-bit read-modify-write order differs (core low byte first, hardware high
  first) and is tolerated: #593.
- Sprites $33, $36 and $A0 hang in INIT in Mesen too, so they have no trace.

## Running it

Fixtures live outside git: `hackbench-tools/fixtures/sprite-trace|sprite-spawn/<sha1-prefix>/`.
Mesen comes from `HB_MESEN`, the ROM from `HB_ROM`. Capture with
`scripts/run_sprite_oracle.ps1`. Node cannot strip the core's TypeScript
parameter properties, so bundle it first:

```
esbuild src/rom/cpu/Cpu65816.ts --format=esm --outfile=core.mjs
node --experimental-strip-types oracle/compare_sprite_trace.mts <fixtures> --core core.mjs --rom <rom>
```

`--core` or `HB_CPU_CORE` overrides the default core (use it for the planted copy).

## Evidence scope

Vanilla SMW (USA) only; one machine; Mesen 2.x; the HandleSprite call
boundary, not whole frames; PPU register effects are out of scope (above).
Smoke check at move time: map 001, 10 of 10 calls MATCH on the repo core.
