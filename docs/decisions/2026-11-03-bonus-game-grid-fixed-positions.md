Ruled 2026-11-03 (Brian, D158 / Decision 124: "D124 A", #998)

# The bonus game grid draws at the game's fixed positions

## Question

Sprite $82 on maps $000 and $100 is a trigger: its INIT writes nine blocks into slots 9 to 1 at fixed positions of the map and ignores where the list placed it (SMWDisX `bank_01.asm:12681-12707`). D137 A says a spawner's children are drawn around the parent's placed spot and move with it on drag. Does the grid follow that, or stay where the game puts it?

## Options considered

A. The grid draws at the game's fixed positions and does not follow the placed sprite or a drag.
B. The grid is moved so it sits around the placed spot and follows a drag (the literal D137 A reading).

## Ruling

A (Brian, 2026-11-03, "D124 A"). B is rejected: it would show a layout the game never produces.

## Why

- The positions come from the game's own tables, not from the list entry (`bank_01.asm:12681-12707`), so the picture is already the game's. `[OBS]` from the disassembly.
- The picture is read from the ROM-run level loader image's INIT (emulated CPU, vanilla, maps $000 and $100, one machine); no hardware capture exists for these maps. `[EST]`

## Scope note

The grid stays put when the list spot changes: proved by a sweep over 28 list spots of map $000 (same parts and box at every one; `BonusGame.test.ts`). The picture is the same 72 cells at every list spot for the vanilla memory setting (0) of map $000; other sprite memory settings put the placed sprite in another slot, and their cell counts range from 35 to 72 with the same box: not traced, so those draw marked unverified ("this map uses sprite memory setting N; the bonus game blocks were only checked for setting 0, so some may be missing"; D57). The replay runs the sprite in the loader's top slot; if an earlier sprite of the list took that slot the game would place it lower, which changes up to 12 of the 72 cells (a block's pixel row and its item tile; the box does not change, measured on $000, one machine). Such a sprite is drawn marked unverified; slot 0 is refused. The vanilla $000 and $100 lists hold only this sprite. The slot and camera rule applies to the map view's at-rest run only; a caller that is not at rest (the spawn grader, the sprite report) keeps its own. The "does not follow a drag" half of the ruling is future behavior: no sprite drag exists in the map view yet, so nothing tests it.

## Applies to

`src/rom/sprites/interp/InitLatches.ts` (the `absolute` flag), the at-rest re-base in `SpriteRunner.ts`, `test/suite/unit/sprites/BonusGame.test.ts`, #998.
