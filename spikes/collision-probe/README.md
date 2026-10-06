# Collision probe (en-gen/hackbench#435)

**Question:** can per-tile collision for the Maps view ("show surfaces", "show walls") come from SMW's own
Mario-vs-layer-1 code run on our 65816 core, instead of the hand port in `TileFactory.classify`, so a hack with
patched block code comes out right?

**Status:** done for vanilla. Three maps generated and checked by eye by the owner: `$105` ("looks great"), `$10A`
(looks right) and `$111` (looks right after the floor-spike fix below). Spike code, not product code; not run by CI.

**Evidence scope:** vanilla US ROM only; tilesets 7, 3 and 1 (maps `$105`, `$10A`, `$111`); small Mario, blue and
silver P-switch off, switch palaces off; horizontal layer-1 path only; one machine, 2026-10-05; not compared against
an emulator.

**Known gaps** (deferred): the other tilesets; the very gentle, steep and conveyor slopes were measured but not
eyeballed on a map; water; vertical levels; layer 2; hacks (patched block code is the reason for this approach but is
untested, to be taken up in a later milestone); big, ducking, Yoshi and cape states.

## Run

```bash
npx tsx spikes/collision-probe/probe.ts --rom <vanilla ROM> --map 105
```

Maps: `105` Yoshi's Island 1, `10a` Vanilla Dome 3, `111` Valley Fortress. `--rom` is required (no default path).
Each run writes `out/<map>.html` and refreshes `out/index.html`, which links every page there. Pages are
gitignored; the one for `105` is `spikes/collision-probe/out/105.html`: the map, the SVG
lines (yellow `#ffeb3b` floors and ceilings, purple `#d500f9` walls, 2 px, `vector-effect: non-scaling-stroke`,
unknown cells hatched), a toggle per group, zoom, a table of tile categories with ids, and the probe-vs-old
disagreements (also outlined red on the map behind a toggle). About 75 s: 512 ids, two states, ~850 M instructions.

## What runs

| Piece                                                                      | Where                                                                                                                                                                                              |
| -------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Level state: the ROM's own loader (tileset, `SlopesPtr`, ObjectTileset)    | `LevelLoader.ts` `loadLevelState`                                                                                                                                                                  |
| Mario's collision body for layer 1                                         | `CODE_00EADB`, SMWDisX `bank_00.asm:11927` (entry, slope and wall tables, the F44D/F461 tile fetch at 13266-13342, the F545 solidity gate at 13410)                                              |
| The per-frame reset it is called after                                     | `CODE_00EAA6`, `bank_00.asm:11921`; the setup between them mirrors `CODE_00E92B`, `bank_00.asm:11723-11768` (layer 1, horizontal)                                                                  |
| Bus and guards                                                             | `SpriteBus` (WRAM, LoROM, `inputs` set) and `guardInstruction` (BRK/COP/WDM/STP, leaving ROM), plus a 20,000-instruction budget per call                                                          |

The probe lays out a 16x16-cell level of air ($025), puts one Map16 id in a cell, and sweeps Mario toward it a pixel
at a time: down for floors (first landing, `$77` bit 2), up for ceilings (`$77` bit 3, or Y speed zeroed, which is how
the turn block bonks), left-to-right and right-to-left at four body heights for walls (`$77` bits 0/1). Floor depth =
final Y + 32 - cell top; ceiling depth = first contact Y + 17 - cell top. Those two offsets were read off the first
contact on a flat block, not taken from a table; they are the small-Mario foot and head reference points.

### Assumed state (also printed on the page)

Small Mario, no item, no Yoshi, not wall-running, not ducking, blue and silver P-switch off, switch palaces off,
note-block flag off, TrueFrame 1 (so the conveyor slopes `$1CE-$1D1` do not shove him, `CODE_00EFCD`), horizontal
level mode. A second pass with the blue P-switch running marks the ids whose result changes (orange outline).
Switch palaces: the collision code never reads `SwitchBlockFlags`; an activated palace replaces the Map16 ids, so
there is nothing to toggle in the probe.

### Unknown and the oracle

A run that throws, exceeds budget or leaves ROM makes the tile `unknown` (hatched). `probe.ts` proves on every run
that this can fail: a ROM copy with a BRK planted at `$00EADB` must give "BRK executed", and a copy with the slope
table `DATA_00E632` zeroed must change a slope's floor (so the probe reads the ROM's table, which is the point).
`compose()` is checked on synthetic tiles (2x2 block gives one top, one underside, two 32 px walls; a two-tile slope
gives one line; an unmeasured tile is unknown). The compose check needs no ROM; the other two do.

## Results, vanilla `Super Mario World (USA)`, map `$105` (tileset 7)

Evidence scope: one machine, one vanilla ROM, one tileset, one run on 2026-10-05; not compared against an emulator.
No tile came out `unknown`.

Categories over all 512 ids (from what was measured): passable 270, solid 108, slope 102, ledge 17, hazard 7,
partial 6, ceiling slope 2. On this map: ledge `$100-$104 $106`; solid `$11A $11E $11F $130 $133-$138 $145 $148
$14B $14C $153-$155 $159-$15C`; slope `$1AA $1AB $1AF $1C4-$1C7`; the rest passable (coins, background, filler
`$1E2-$1EF $1F7 $1F8`). 48 floor/ceiling polylines, 60 wall lines. This map has no muncher, spike, lava,
ceiling slope, note block or P-switch block; the next maps must (`$10B` DS2 has munchers).

Notable measured behaviour:

- Filler tiles `$1D8-$1FA` are passable on their own (`CODE_00ED4A`: they only borrow the slope of the cell above).
  They draw nothing, which is right: the slope above already carries the line.
- `$1FB-$1FF`, `$12F` (muncher) and page-0 `$005` hurt or kill (`$71` set); drawn as measured, tagged hazard in the table.
- `$021-$024` (invisible blocks): ceiling only, from below. `$0EC-$0FB` (big switch tiles) are solid.
- `$1C8/$1C9` are ceiling slopes (signed heights); `$1CB/$1CD` mix a floor half and a ceiling half. In their ceiling
  half Mario lands ABOVE the cell top (8-bit wrap of the signed height): counted, not drawn.
- Tile `$029` (invisible POW block), `$02B` (coin) and `$132` (brown block) change with the blue P-switch.
- Game state read before written (top: `$1931` ObjectTileset, `$1407` FlightPhase, `$13ED` PlayerSlopePose, `$1DF9`
  sound, `$15` held buttons, `$82-$84` SlopesPtr). The full count per address is at the bottom of the page.

### Disagreements with `TileFactory.classify` (53 of 512 ids; full list on the page)

| Ids                                            | Probe                      | Old                                                                  |
| ---------------------------------------------- | -------------------------- | -------------------------------------------------------------------- |
| `$012 $014 $017-$01F $020 $025-$029 $06A $06B` | nothing                    | ceiling                                                              |
| `$011 $013 $015`                               | nothing                    | floor + ceiling                                                      |
| `$016`                                         | nothing                    | floor + ceiling + wall                                               |
| `$0EC-$0FB`, `$12A-$12E`, `$166-$169`          | solid                      | nothing (old drops coins/checkpoint ids by id, ignoring the page bit) |
| `$12F`                                         | ceiling + wall + hurt      | nothing                                                              |
| `$1C8 $1C9`                                    | ceiling slope              | floor slope (signed heights drawn as floor)                          |
| `$1CB $1CD`                                    | floor half + ceiling half  | floor slope / nothing                                                |

The ROM's head-hit path for page 0 accepts only `$21-$24` (`CODE_00EC8A`, `bank_00.asm:12194-12205`), so the old
ceiling for the other page-0 ids has no counterpart in the routine. Open for review: the old port may encode intent
the routine does not show (blocks it wants hit from below).

## Maps `$10A` and `$111` (added after sign-off on `$105`)

Chosen with `find_l1_tile_levels` plus a scan of every level's Map16 ids against the probe's categories per
tileset (13 of 16 tilesets have levels; `$105` is tileset 7). Two maps cover everything `$105` lacked:

| Map | Tileset | Covers (ids measured on the map) |
| --- | --- | --- |
| `$10A` Vanilla Dome 3 | 3 | muncher `$12F` (hazard); ceiling slopes `$1C8 $1C9`; floor/ceiling halves `$1CB $1CD`; invisible block `$021`; P-switch-dependent `$029 $02B $132`; note-block ids `$159-$15B` (partial); slopes `$16E-$1B5 $1CA $1CC`; `$1FB $1FD-$1FF` hazard |
| `$111` Valley Fortress | 1 | `$005` and `$159 $15A $15C` hazard (tile `$005` is the `CPY #$05` kill, `CODE_00EDDB`, `bank_00.asm:12383-12386`; `$159-$15C` hit `HurtMario` for tileset 1 through `CODE_00F127`, `bank_00.asm:12789-12815`); solid `$15D-$165` |

The note block is `$15A` (low byte `$5A` takes the `$59/$5A` side door of `CODE_00F160`, `bank_00.asm:12828-12846`, into
`DATA_00F05C` entry `$10`); the probe reports it `partial` on tileset 3 and `solid` on tileset 0. The same ids
`$159-$15C` mean hazards on tilesets 1, 5 and 13 and notes/doors elsewhere, so a tile's meaning is per tileset: the
page shows the categories of the tileset it was run for. One map cannot cover both groups (hazards `$159-$15C` and
munchers live in different tilesets), two can. Spikes and lava here mean those measured hazard ids; I did not name
graphics.

Bug found and fixed while scanning: some levels (tilesets 4, 9, 12, 13) load with `$71` PlayerAnimation set by their
entrance, which read as "hurt" on every id. `Probe.run` now clears `$71` first. `$105`, `$10A`, `$111` were
regenerated after the fix (their level images had `$71` = 0, so their results did not change).

Disagreements with `TileFactory.classify` beyond the 53 on `$105` (ids not in that set, per map):

| Map | Ids | Probe | Old |
| --- | --- | --- | --- |
| `$10A` (63 total) | `$1C4-$1C7` | ceiling | floor + ceiling |
| `$10A` | `$1D2-$1D7` | nothing | floor (fillers drawn as floor by old) |
| `$111` (61 total) | `$159 $15A $15B $15C` | ceiling + wall (hurt) | nothing |
| `$111` | `$1C4-$1C7` | ceiling | floor + ceiling |
| `$111` | `$166-$169` | ceiling + wall (hurt) | nothing (on `$105` the same ids are solid: tileset-dependent) |

Evidence scope as above: vanilla US ROM, one machine, one run on 2026-10-05, tilesets 7, 3 and 1 only.

## Floor-spike fix (`$111`)

The floor spikes drew no top line: ids `$159 $15A $15C` (and `$005`, `$12F`, `$166-$169`, `$1FB-$1FF` elsewhere) kill small
Mario on contact, and the probe waited for the landing flag. `HurtMario` -> `KillMario` (`bank_00.asm:13522`) leaves Y
speed `$90`, and `CODE_00EE85` (`bank_00.asm:12482-12488`) returns early for a negative Y speed, before the `$77`
bit 2 write; at the foot-touch step on `$159` the run showed `$77` = 0, `$71` = 9, Y speed `$90`. The cause was the probe
(compose was fine). The from-above sweep now takes the first contact that sets `$71` as the surface, at the same foot
offset as a landing. The self-test plants a ROM copy where block `$130`'s top hit calls `HurtMario`: it fails before the
fix (floor empty, hurt true) and passes after (floor 0 in all 16 columns). Only hazard ids changed, in all three maps
(see the list above); by the ROM these tiles kill from above whatever their graphic, so the downward-pointing ones now
also get a top line.

## `SurfacePath` span logic (`src/rom/model/SurfacePath.ts`)

It has no horizontal logic at all. Per column it walks rows top-down and emits one entry per floor cell, except a
flat cell whose cell directly above is also a floor (silhouette top). Slopes always emit and count as floor for the
cell below. `nextSurface` (walking-sprite use) matches column to column by edge height within 16 px, but that is not
drawing. `drawSurfaces` draws each slope cell as its own sub-path (no cross-tile join), draws a ceiling line unless
the cell below is a ceiling, and `drawWalls` draws a vertical edge per cell whose horizontal neighbour is not wall-ish (slopes count as wall-ish), unmerged. So it joins nothing across tile boundaries and sees only
the immediate vertical neighbour. The probe's `compose.ts` instead chains per-pixel-column samples across cells
(adjacent columns within 2 px join), and drops a floor sample when the cell above has a floor in that column, a
ceiling sample when the cell below has a ceiling, and a wall face when the neighbour blocks the opposite face.

## Risks and open questions

1. Isolated-tile probing misses neighbour-dependent behaviour: fillers borrow the slope above, and a ledge on a
   solid is treated as fill by the compose rule.
2. Walls are drawn on the tile edge; contact is a few pixels inside it (`DATA_00E911`), not measured per tile.
3. Wall height is sampled at four body heights, so a tile that blocks only part of the body reads as a full wall.
4. Mario only; big, ducking, Yoshi and cape states are not probed. Silver P-switch is not probed.
5. Vertical levels and layer 2 are not covered (probe uses the horizontal layer-1 path).
6. A hack that moves the entry points or the loader shape is refused by `loadLevelState` (as for sprites), not
   probed. Not tried on a hack here.
