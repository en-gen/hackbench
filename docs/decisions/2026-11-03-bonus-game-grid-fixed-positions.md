Ruled 2026-11-03 (Brian, D158 / Decision 124: "D124 A", #998)

# The bonus game grid draws at the game's fixed positions

## Question

Sprite $82 on maps $000 and $100 is a trigger: its INIT writes nine blocks into slots 9 to 1 at fixed positions of the level and ignores where the list placed it (SMWDisX `bank_01.asm:12681-12707`). D137 A says a spawner's children are drawn around the parent's placed spot and move with it on drag. Does the grid follow that, or stay where the game puts it?

## Options considered

A. The grid draws at the game's fixed positions and does not follow the placed sprite or a drag.
B. The grid is moved so it sits around the placed spot and follows a drag (the literal D137 A reading).

## Ruling

A (Brian, 2026-11-03, "D124 A"). B is rejected: it would show a layout the game never produces.

## Why

- The positions come from the game's own tables, not from the list entry (`bank_01.asm:12681-12707`), so the picture is already the game's. `[OBS]` from the disassembly.
- The picture is read from the ROM-run level loader image's INIT (emulated CPU, vanilla, maps $000 and $100, one machine); no hardware capture exists for these maps. `[EST]`

## Applies to

`src/rom/sprites/interp/InitLatches.ts` (the `absolute` flag), the at-rest re-base in `SpriteRunner.ts`, `test/suite/unit/sprites/BonusGame.test.ts`, #998.
