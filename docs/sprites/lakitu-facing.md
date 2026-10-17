# Lakitu ($1E) facing in the map view (#1007)

The rider's `$157C` is not written by its INIT (`InitLakitu`, SMWDisX `bank_01.asm:687-729`, which only
spawns the cloud in `FindFreeSprSlot`'s slot). The cloud's MAIN (`bank_01.asm:13963`) scans slots 9..0 for
status 8 and number `$1E` (13992-14002), keeps the slot in `$160E,X`, and `CODE_01E98D` (14216-14222) stores
`SubHorizPos` (6124-6134, measured from the cloud, which starts on the rider) into the rider's `$157C`.

## What this means for the picture

The sprite loop counts slots 11 down to 0. So:

- The map view draws on MAIN pass 0, after the cloud has run at least once, whatever slot either has: the drawn
  `$157C` is the SubHorizPos side for a rider in slots 0-9.
- A sample taken right after INIT (the layers_v5 capture's `initFacing`, #272) is that side only when the
  cloud's slot is below the rider's; otherwise it is 0. This is why #272's four `$1E` records (maps `11f`,
  `132`, `1c4`, `1c5`) differ: the capture's cloud slot is not recorded. It is a sampling-time difference, not a
  wrong picture.
- A rider in slot 10 or 11 is outside the cloud's scan and stays at 0, on hardware too. The issue's "slots 0-11
  equal SubHorizPos" is read as slots 0-9; the tests assert the hardware.

## Evidence

`test/suite/unit/sprites/LakituFacing.test.ts`. Vanilla ROM, one machine, runner as of this change:

- Synthetic cart (no ROM): a rider that spawns a cloud in the highest free slot, and a cloud MAIN with the real
  routine's shape; slots 0-11, both Mario sides. A variant whose cloud MAIN does not store goes red.
- Vanilla maps `11f`, `132`, `1c4`, `1c5`: each map's own `$1E` entries, the loader's Mario, slots 0-11, pass-0
  and post-INIT `$157C`. Disabling the store at `$01:E998` in a fresh ROM copy goes red.

No product change: the map view already draws this facing.
