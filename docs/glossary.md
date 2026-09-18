# Domain terms

Agreed 2026-09-17. These words appear in code, comments, commits, issues and
UI. Using them loosely is how this project produced five different level
counts, none of which were measuring the same thing.

## The unit words

**Slot.** One of the 512 pointer-table indices, `$000` to `$1FF`. A slot
exists whether or not anything is in it. At each index sit THREE parallel
pointers, not one:

| table | address |
|---|---|
| L1, terrain | `$05E000 + index * 3` |
| L2, background | `$05E600 + index * 3` |
| sprites | `$05EC00 + index * 3` |

**Empty slot.** A slot whose L1 pointer is the ROM's filler value. On vanilla
that is `$068000`, shared by 277 slots. The filler is computed per ROM as the
modal L1 pointer; it is never hardcoded. Empty slots are free space a hack
author can fill.

**Map.** A slot holding real data. The editable unit, and what a `.smwmap`
file opens. Vanilla has 235.

> **A map's identity is its slot index, never its L1 pointer.**
>
> On vanilla, 63 maps share an L1 pointer with another map, and 61 of those
> still differ in their L2 or sprite pointer. They are distinct maps reusing
> the same terrain. Treating a shared L1 as "the same map" silently drops 61
> real maps, which is exactly the defect that made `$016` and `$017` vanish
> from the tree while `$015` survived, all three sharing L1 `$0691E5`.

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

| reachable from the overworld | reachable from another map | the map is |
|---|---|---|
| yes | either | an entry map |
| no | yes | a sub area |
| no | no | an orphaned map |

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

| Avoid | Because | Say |
|---|---|---|
| "Map" for the overworld | collides with map-the-editable-unit | "overworld" |
| "Maps" for levels | the tree's folders are levels, not maps | "levels" |
| "area" for a submap | collides with sub area | "submap" |
| "level" for a slot or a map | a level is composed of maps | "slot" or "map" |
| "extras" or "unlinked" | vague; says what it is not | "orphaned map" |
| bare "exit" for the object | collides with the 96 counter | "screen exit" |

`Map16` is exempt. It is the standard SMW name for the tile format and does
not collide in practice.

## Counts on vanilla, for orientation

| | |
|---|---|
| slots | 512 |
| empty slots | 277 |
| maps | 235 |
| launch tiles carrying a translevel | 92 |
| of those, entering a level | 86 |
| levels | 77 |
| exits (documented) | 96 |

Resolved, on the tiles that decide 77 versus 79: Map16 tile `$5A` is the
pre-activation state of a star road node. The overworld event system swaps it
to `$5F`, which `OWPU_ABXY` diverts as a star warp before reaching
`OWPU_EnterLevel` (`bank_04.asm:1752-1754`). The swap is ROM data, pair 14 of
the 22 in the event tile-swap tables at `$04DA1D` (from) and `$04DA33` (to).
The rest of that table is the level-completion swap set (`$6E`->`$66`,
`$70`->`$68` and so on), so `$5A`->`$5F` sits in the same mechanism.

So a `$5A` tile never enters a level, and the two launch tiles named STAR ROAD
that hold real map data (`$016`, `$108`) are not levels.
