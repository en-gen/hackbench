# Lakitu ($1E) facing in the map view (#1007)

The rider's `$157C` is not written by its INIT (`InitLakitu`, SMWDisX `bank_01.asm:687-729`, which only
spawns the cloud in `FindFreeSprSlot`'s sprite table slot). The cloud's MAIN (`bank_01.asm:13963`) scans slots
9..0 for status 8 and number `$1E` (13992-14002), keeps the slot in `$160E,X`, and `CODE_01E98D` (14216-14222)
stores `SubHorizPos` (6124-6134, measured from the cloud, which starts on the rider) into the rider's `$157C`.

## What this means for the picture

The sprite loop counts sprite table slots 11 down to 0. So:

- The map view draws on MAIN pass 0, after the cloud has run at least once, whatever slot either has: the drawn
  `$157C`, and the flip of Lakitu's own parts (chars `$1EC`/`$1EE`), is the SubHorizPos side for a rider in
  sprite table slots 0-9, on both sides of Mario.
- A sample taken right after INIT is that side only when the cloud's slot is below the rider's; otherwise it is
  0 (tested here on the runner). That Echo's capture-based `initFacing` for the four `$1E` records of #272 (maps
  `11f`, `132`, `1c4`, `1c5`) differs for this reason is an UNTESTED INFERENCE: the capture does not record the
  cloud's slot and it was not checked against the capture records.
- A rider in slot 10 or 11 is outside the cloud's scan and stays at 0. That is unreachable for a vanilla-loaded
  Lakitu (the free-slot search starts at `SpriteSlotMax`, `bank_02.asm:5182-5184, 5524-5530`, at most 9, often 7),
  so it is covered by the synthetic cart only. The issue's "slots 0-11 equal SubHorizPos" is read as slots 0-9
  for that reason. Proposed reading, pending owner review.

## Evidence

`test/suite/unit/sprites/LakituFacing.test.ts`, commit on `feature/1007-lakitu-facing`, 2026-10-17, one machine,
the runner as on `develop` 9a039005, vanilla ROM:

- Synthetic cart (no ROM): a rider that spawns a cloud from slot 7 down, and a cloud MAIN with the real routine's
  shape; slots 0-11, both Mario sides. Variants whose cloud MAIN does not store, or is a bare RTS, go red.
- Vanilla maps `11f`, `132`, `1c4`, `1c5`: each map's own `$1E` entries, the loader's Mario and Mario mirrored to
  the other side, slots 0-11: pass-0 and post-INIT `$157C`, and the drawn flip. Disabling the store at `$01:E998`
  goes red; so does `SubHorizPos`'s result forced to 1 (`$01:AD3F` 01 to 00, a smoke test, not a coverage claim).

No product change: the map view already draws this facing.
