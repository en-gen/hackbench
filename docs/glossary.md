# Domain terms

Agreed 2026-09-17. These words appear in code, comments, commits, issues and
UI. Using them loosely is how this project produced five different level
counts, none of which were measuring the same thing.

## The unit words

**Slot.** One of the 512 pointer-table indices, `$000` to `$1FF`. A slot
exists whether or not anything is in it. At each index sit THREE parallel
pointers, not one:

| table          | address               |
| -------------- | --------------------- |
| L1, terrain    | `$05E000 + index * 3` |
| L2, background | `$05E600 + index * 3` |
| sprites        | `$05EC00 + index * 2` |

The sprite entry is 2 bytes; stock code supplies bank `$07` as a literal
([map-data-mechanics.md](rom/map-data-mechanics.md)).

**Empty slot.** A slot whose L1 pointer is the ROM's filler value. On vanilla
that is `$068000`, shared by 277 slots. The filler is computed per ROM as the
modal L1 pointer; it is never hardcoded. Empty slots are free space a hack
author can fill.

**Map.** A slot holding real data. The editable unit, and what a `.smwmap`
file opens. Vanilla has 235.

> **A map's identity is its slot index, never its L1 pointer.**
>
> On vanilla, 63 maps share an L1 pointer with another map, in 21 groups,
> holding 32 distinct (L1, L2, sprite) pointer triples. 30 of the 63 have a
> partner that differs in L2 or sprite, and 56 share all three pointers
> with another map, as `$015` and `$016` do; those are still separate maps,
> because identity is the slot. Treating a shared L1 as "the same map"
> collapses the 63 to 21, silently dropping 42 maps and 11 of the pointer
> triples. That is exactly the defect that made `$016` and `$017` vanish
> from the tree while `$015` survived, all three sharing L1 `$0691E5`.
> (Measured 2026-09-28 on the vanilla ROM, sprite pointers read 2 bytes
> wide.)

**Level.** What the player enters from the overworld. A level is composed of
maps: one entry map plus its sub areas.

**Entry map.** The map a launch tile starts. One per level. It is the level's
way in, and clicking a level in the tree opens it.

**Sub area.** A map that is NOT reachable from the overworld but IS
reachable from another map. There is no depth qualifier: a map three screen
exits deep is a sub area, not a "sub sub area".

Defined by reachability rather than by ownership, which settles two cases
cleanly. A map reachable from two different levels is simply a sub area; no
argument about which level owns it. And a map that some other map exits into
is still an ENTRY MAP, not a sub area, if the overworld also reaches it.
(Vanilla has no such map: zero maps are both an overworld destination and a
screen-exit destination.)

Together the three categories partition every map by reachability:

Every map falls in exactly one of these, decided purely by reachability:

| reachable from the overworld | reachable from another map | the map is      |
| ---------------------------- | -------------------------- | --------------- |
| yes                          | either                     | an entry map    |
| no                           | yes                        | a sub area      |
| no                           | no                         | an orphaned map |

A worked case, because it gets re-litigated. Map A exits into map B, and
nothing reaches A. Then A is ORPHANED (nothing reaches it) and B is a SUB
AREA (a map reaches it). B is a sub area even though it belongs to no level,
because the role is decided by reachability from another map, not by tracing
back to the overworld.

That means **a sub area need not belong to any level**, and a level is an
entry map plus the sub areas reachable FROM IT, not every sub area in the
ROM.

Vanilla has no instance: all 99 of its sub areas trace back to an entry map
(measured against the pre-Tier-2 entry set, so treat it as indicative). The
shape matters anyway, because it is the normal work-in-progress state for
someone building a hack: two connected maps that are not on the overworld
yet.

**Orphaned map.** A map reachable from nothing: no launch tile enters it and
no other map exits into it. The name is literal, it has no parent. Not a
defect and not junk: in an editor this is work in progress, and on a stock
ROM it is leftover data.

## The overworld words

**Submap.** One of the overworld's regions. The ROM's own word
(`CurrentSubmap`). Vanilla has 7, but that is a data convention, not an
engine limit: no bounds check exists on the submap value.

**Launch tile.** An overworld tile that enters a level. Vanilla has 92
carrying a translevel, of which 86 enter a level rather than warping.

**Translevel.** The overworld's own numbering of launch tiles, assigned by
walking the tile data. Converted to a slot index by two INDEPENDENT gates:
the low byte subtracts `$24` at or above `$25`, and the high byte comes from
the submap, NOT from the translevel (`bank_05.asm:7217-7226`). Conflating
those two gates is correct on vanilla and wrong in principle.

## The connection words

**Screen exit.** The object inside a map that leads to another map: a pipe, a
door, a screen boundary. Qualify it; do not call it just "exit".

**Exit.** What the documented "96 exits" counts, meaning a goal reached. A
level can have more than one. Distinct from a screen exit, and not derivable
from the overworld.

**Entrance.** Reserved for the ROM's primary and secondary entrance data
(`DATA_05F200`, `DATA_05FA00`, `DATA_05FC00`). Do not use it for launch
tiles.

## Words to avoid

| Avoid                       | Because                                 | Say                                   |
| --------------------------- | --------------------------------------- | ------------------------------------- |
| "Map" for the overworld     | collides with map-the-editable-unit     | "overworld"                           |
| "Maps" for levels           | the tree's folders are levels, not maps | "levels"                              |
| "area" for a submap         | collides with sub area                  | "submap"                              |
| "level" for a slot or a map | a level is composed of maps             | "slot" or "map"                       |
| "extras" or "unlinked"      | vague; says what it is not              | "orphaned map"                        |
| bare "exit" for the object  | collides with the 96 counter            | "screen exit"                         |
| "Layer 1/2/3" in the UI     | numbers invert image-editor stacking    | "Foreground", "Background", "Effects" |
| bare "layer" for graphics   | collides with an op layer               | "graphics layer" or the role name     |

`Map16` is exempt. It is the standard SMW name for the tile format and does
not collide in practice.

## Counts on vanilla, for orientation

|                                    |     |
| ---------------------------------- | --- |
| slots                              | 512 |
| empty slots                        | 277 |
| maps                               | 235 |
| launch tiles carrying a translevel | 92  |
| of those, entering a level         | 86  |
| levels                             | 77  |
| exits (documented)                 | 96  |

Resolved, on the tiles that decide 77 versus 79: Map16 tile `$5A` is the
pre-activation state of a star road node. The overworld event system swaps it
to `$5F`, which `OWPU_ABXY` diverts as a star warp before reaching
`OWPU_EnterLevel` (`bank_04.asm:1752-1754`). The swap is ROM data, pair 14 of
the 22 in the event tile-swap tables at `$04DA1D` (from) and `$04DA33` (to).
The rest of that table is the level-completion swap set (`$6E`->`$66`,
`$70`->`$68` and so on), so `$5A`->`$5F` sits in the same mechanism.

So a `$5A` tile never enters a level, and the two launch tiles named STAR ROAD
that hold real map data (`$016`, `$108`) are not levels.

## The graphics words

A map is drawn as four graphics layers. The UI names them by ROLE and never
by number.

| UI name        | ROM name     | What it is                                                                                                                                                       |
| -------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Foreground** | Layer 1, BG1 | The terrain the player walks on, built from the map's object stream through Map16.                                                                               |
| **Background** | Layer 2, BG2 | Behind the foreground. Either a preset pattern that repeats across the map, or built from its own object stream like the foreground, with its own screen stride. |
| **Effects**    | Layer 3, BG3 | A fixed image chosen per level (none, or one of three per tileset). Drawn 2bpp, and never through Map16.                                                         |
| **Sprites**    | OAM          | Objects placed at free positions rather than on a grid.                                                                                                          |

**Why roles, not numbers.** SNES numbers its layers by PPU channel, not by
depth, and Layer 1 is the FRONT one. Anyone who thinks in image-editor
stacking reads "Layer 1" as the bottom, the owner included. Veterans of other
editors read it correctly. A role name misleads neither group, so the number
never appears as a label. It may appear in a tooltip, because two decades of
tutorials and patch readmes say "Layer 2" and a user following one needs the
bridge: shown, never required, per `docs/ui-conventions.md`.

**Why Effects has no depth in its name.** A bit in the level header decides
whether Effects draws behind everything or in front of everything, sprites
included (`bank_05.asm:588-598` shifts it into `MainBGMode`,
`bank_00.asm:464-465` writes that to `$2105`). "Overlay" is wrong whenever
the bit is clear. Effects names the content, which stays true either way.

**Graphics layer.** The umbrella for the four above. Say it in full: a bare
"layer" is an op layer, defined under Editing below.

**Priority plane.** Half of a graphics layer, split by the priority bit in
each 8x8 subtile word (bit 13). Priority is per QUADRANT, not per 16x16
tile: one Map16 tile can have two quadrants in front of sprites and two
behind. This is how part of a pipe draws over the player while the rest does
not.

## Editing

**Base ROM.** The ROM file exactly as the user supplied it. Referenced
by identity (`RomIdentity`) and never modified; a project can be shared
without ever containing a byte of it.

**Op.** One BGR555 word write: `{ address, old, new }`, all hex strings.
`address` is a 24-bit SNES address, not a semantic path. `old` is carried so
undo is a write-back rather than a recomputation, and so applying an op can
refuse when the address no longer holds it. Fully committed alongside the
project (`ops/`) - a collaborator who clones the project gets working undo
without needing the machine the edit was made on.

**Layer.** A named, ordered list of ops (`WorkingRom.Layer`). Layers stack
append-only; nothing is ever removed from the middle. An `edit` layer
persists and exports. `WorkingRom` also supports a `preview` scope that
neither persists nor exports, but nothing currently creates one: the
palette editor commits directly (pick a color, click OK) rather than
staging a per-tick drag layer, after an earlier version of that design
caused a real bug. The scope stays as a general `WorkingRom` capability for
whichever editor needs a live, discardable layer next.

**Redo area.** `ops/redo/`, holding layers `undo` took off the top of the
stack. The append-only rule still holds where it matters - a layer only ever
leaves the top, and a redo only ever puts one back on the top - but an undone
layer is KEPT rather than deleted, and kept on disk, so redo survives closing
the project. A new edit ends the redo future and empties the directory: a
layer held across a divergent edit would re-apply against bytes the user never
looked at, which `WorkingRom.redo`'s `old` check refuses anyway. Because
`ops/` is committed, `ops/redo/` is too, so a diff can contain layers that are
not applied to the working copy; they are the same hex-text ops, never
ROM bytes.

**Working copy.** The base ROM with every layer in a project's stack
applied, IN ORDER (`WorkingRom.bytes()`). A MIGRATED view renders this, never
the base ROM directly - an edit made in one such view (a palette
color) is invisible everywhere else otherwise. Concretely: every
`theia/extension/src/node/*-server.ts` reads the ROM through
`WorkingRomRegistry`, not `RomFile.load`. `project-server.ts` is the one
exception, because it is what RESOLVES the ROM in the first place,
before any working copy exists to read from - `WorkingRomRegistry` itself
calls `RomFile.load` once, on first access per project.

Palette and GFX are migrated, and both push a re-render to an open widget on
the working copy's change event (`WorkingCopyNotifier`). The map view is
NOT yet: `project-server.ts`'s `mapDetails`/`loadMaps` still read the base
ROM directly, so a palette edit is not visible there. That migration
is unstarted work, done per view rather than assumed.
