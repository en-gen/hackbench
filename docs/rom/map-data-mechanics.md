# Map data mechanics: growth, relocation, sharing, sprites, acts-like

What the ROM allows when a map is edited: how its streams end, whether they
can grow, where they can move, who else points at them, and what "acts like"
is. Part 1 of the 2026-09-17 map editor proposal; its UI parts targeted the
retired VS Code editor and were dropped. Constrains #182, #57 and #178.
Terms are the [glossary](../glossary.md)'s.

**Evidence scope.** The six-ROM corpus in `hackbench-tools/roms`
([testing.md](../testing.md)): vanilla, `magic` (a Lunar Magic resave of
vanilla), Seven_Vanilla_Levels, GrandPooWorld_V1.2, Grand Poo World 2 1.1
and Invictus 1.0. Measured 2026-09-17, re-measured 2026-09-28, one machine,
with HackBench's stream walkers (`getObjectStreamLength` skipping the
5-byte header for L1 and L2, `getSpriteStreamLength`). No emulator run.
The four edited hacks carry Lunar Magic's `$05D8B1` hook, as do 99 of 99
hacks in the #275 store (#311); attributing a byte pattern to Lunar Magic
here is inferred from that hook, not from its documentation.

## 1. What happens when a map grows

**It does not fit. Growing a map by one byte overwrites whatever follows it,
so any growth is a relocate-and-repoint, not a local edit.**

### The engine has no length field

The object stream is terminated, not counted. `LoadLevelData` reads three
bytes at a time and, after each object, tests the next byte for `$FF`
(`bank_05.asm:792-798`). The 5-bit value in header byte 0 that
`LevelParser.parseLevelHeader` calls `levelLength` is a _screen_ count, not a
byte count: `AND #$1F : INC A : STA LevelScrLength` (`bank_05.asm:527-529`).
Nothing stops one map's stream running into the next; whether an edit fits
depends only on how the bytes happen to be laid out.

### They are laid out with no room at all

Vanilla, all 512 slots, every distinct data block in the L1, L2 and sprite
tables, each block compared with the next block of any stream:

| stream    | distinct blocks | blocks with **zero** bytes before the next block | free bytes after the rest |
| --------- | --------------- | ------------------------------------------------ | ------------------------- |
| L1 object | 194             | 182 (94%)                                        | 6788                      |
| L2 object | 17              | 16 (94%)                                         | 1159                      |
| sprite    | 177             | 171 (97%)                                        | 281                       |

Adding one object to any of the 182 tightly packed L1 maps corrupts the map
stored after it. L2 object streams start with a 5-byte header the loader
skips (`bank_05.asm:462-470`); a walker that does not skip it reads 16 of
the 17 L2 blocks as overlapping the block after them.

### There is barely any free space to relocate into

On vanilla, all map data sits in banks `$06` and `$07`:

| bank                      | referenced by a pointer | not referenced | largest free run        |
| ------------------------- | ----------------------- | -------------- | ----------------------- |
| `$06` (`$068000-$06FFFF`) | 26443 B                 | 6325 B         | 2759 B at file `$37539` |
| `$07` (`$078000-$07FFFF`) | 24576 B                 | 8192 B         | 6289 B at file `$3E76F` |

14517 unreferenced bytes in total, in 20 runs (9 in bank `$06`, 11 in
`$07`), 8 of them 256 bytes or larger. **Unverified:** this checks only that no L1, L2 or sprite pointer
reaches these runs. It does not establish that nothing else in the ROM uses
them, and the disassembly has no label at `$07E800`, so the 6289-byte tail
is unidentified rather than confirmed free.

### A relocated block cannot cross a bank boundary

`LoadLevelData` advances the data pointer 16 bits at a time: it adds to
`Layer1DataPtr` and `Layer1DataPtr+1` with carry and never touches
`Layer1DataPtr+2` (`bank_05.asm:689-695`). A stream that ran off the end of
its bank would wrap to the bottom of the same bank, not continue into the
next. On vanilla, 0 of the 211 L1 and L2 blocks cross the 32 KB LoROM window
boundary at file `$38000`. A relocation target must be a contiguous run
inside one bank.

### What the corpus hacks do

The L1 and L2 pointers are 3 bytes and the game dereferences them long
(`bank_05.asm:7235-7246`), so they may target any bank. Counting slots whose
L1 pointer leaves the vanilla `$06`/`$07` region (mirror bit ignored):

| ROM                   | size   | L1 slots outside `$06-$07` | highest bank byte, raw               |
| --------------------- | ------ | -------------------------- | ------------------------------------ |
| vanilla               | 512 KB | 0 / 512                    | `$07`                                |
| Seven_Vanilla_Levels  | 1 MB   | 52 / 512                   | `$93` (the `$80`-up mirror of `$13`) |
| GrandPooWorld_V1.2    | 2 MB   | 68 / 512                   | `$1E`                                |
| Grand Poo World 2 1.1 | 4 MB   | 168 / 512                  | `$FC`                                |
| Invictus 1.0          | 4 MB   | 199 / 512                  | `$FE`                                |

Every edited ROM has moved map data into expanded space, the bigger the
hack the more. Three of the four (all but Seven_Vanilla_Levels) show a
median L1 slack of 8 bytes where vanilla shows 0, so the relocating tool
also pads. Why 8 is not established; this measures output, not design.

The walker reads the stock record format, which is what section 2
describes; the hacks may use records it does not know. L1 blocks whose
walked length runs past the start of the next block of any stream (sprite
banks read from `$0EF100`): 0 of 194 on vanilla, 11 of 214 on
Seven_Vanilla_Levels, 3 of 199 on GrandPooWorld_V1.2, 35 of 264 on Grand
Poo World 2 (an independent review counted 36) and 62 of 320 on Invictus.
So hack block lengths, and the slack derived from them, are approximate.

**So extending a map is a ROM space-allocation problem, and an editor needs
a free-space allocator (#57) before it needs object placement.**

### Screens are free

Adding or removing _screens_ is not the same operation as adding objects.
`LevelScrLength` feeds runtime bound checks: off-screen culling
(`bank_02.asm:2391, 2442, 2764, 2825, 5008, 5073, 7688, 7735, 10695, 10757`),
camera limits (`bank_01.asm:2866, 2934`) and block-touch bounds
(`bank_00.asm:13299, 13326`). It is also copied into `LastScreenHoriz` and
`LastScreenVert` at load (`bank_05.asm:555-561`), and a boss overwrites it
with `$FF` (`bank_03.asm:9937`). No table in ROM or RAM is sized by it.
Changing the screen count is an in-place edit of one header field, costs
zero bytes and moves no data. The ceiling is 32 screens, because the field
is 5 bits (`bank_05.asm:527-528`).

## 2. Adding, removing and moving an object

### Encoding

Records are 3 bytes, except in one case. `LoadLevelData` reads exactly three
bytes and advances by three (`bank_05.asm:679-695`). The object number is
`$5A = ($0B >> 4) | (($0A & $60) >> 1)` (`bank_05.asm:696-706`). When it is
zero the record is an extended object, and extended object `$00` (a screen
exit) consumes one further byte in its handler, `CODE_0DA512`
(`bank_0D.asm:1416-1427`). So in the stock format records are 3 or 4 bytes,
and the width is only known after decoding all three: the first two give
object number 0, and the third is the extended-object number that selects
the handler (`bank_0D.asm:1058-1063`). The stream ends at `$FF`
(`bank_05.asm:794`).

An editor therefore cannot index the stream; it must re-walk it.
`getObjectStreamLength` in `src/rom/LevelParser.ts` does.

### Order is draw order

`LoadLevelData` handles one object at a time, each writing through
`Map16LowPtr` into the same map buffer (`bank_05.asm:764-788`), so a later
object paints over an earlier one. `src/rom/ObjectExpander.ts` mirrors this
by expanding the parsed objects in stream order.

**Moving an object in space and moving it in draw order are different
operations.** A spatial move rewrites two coordinate nibbles in place, costs
nothing, and is safe. A reorder moves a 3-or-4-byte record to a different
offset in the stream, which is where the screen counter bites.

### Screens are a running counter, not an index

There is no per-screen table and no per-screen offset. Bit 7 of byte 0 is a
"new screen" flag, and the game accumulates it: the parser shifts that bit
into carry and adds it to the running screen counter (`bank_05.asm:754-758`). An
object's screen is whatever the running total is when the parser reaches
it. Extended object `$01` sets the counter to an arbitrary value instead
(`CODE_0DA53D`, `bank_0D.asm:1441-1446`).

Consequences for any drag interaction:

1. An object's screen is a function of its _position in the stream_, not of
   a field it owns. Dragging an object across a screen boundary means moving
   its record into a different run of the stream.
2. Moving a record that carries the new-screen bit shifts every later object
   by one screen. Insert and delete have the same hazard.
3. Between extended `$01` records the counter only increments, so each
   segment of the stream is sorted by screen. A `$01` can set the counter
   lower, starting a new segment. An editor must keep each segment sorted,
   keep every `$01` reset where it is relative to the objects around it, and
   recompute the new-screen bits after any structural edit.
4. Reordering _within_ a screen is safe and is the draw-order operation.
   Reordering _across_ screens is a move plus a re-flag.

So treat the stream as a projection: parse to a list, edit the list,
serialize from scratch, recomputing new-screen bits from each object's
screen. Every edit then rewrites the whole stream, which returns to
section 1: the new stream is rarely the same length as the old one.

## 3. What "acts like" is

### In vanilla, acts-like is the Map16 tile number itself

Map16 definitions carry no behavior byte. When a map loads, `Map16Pointers` is
filled from `TilesetMAP16Loc` by advancing each source pointer 8 bytes per
tile (`bank_05.asm:269-303`), four 8x8 subtiles of two bytes each. There is
no ninth byte and no parallel behavior array in the load path.

The player's block check reads the tile number out of the map's Map16
buffer (`LDA [_0] : STA Map16TileNumber`, `bank_00.asm:13346-13347`), then
translates it through `JSL CODE_00F545` (`bank_00.asm:13351`, routine at
`13410-13461`). That routine rewrites `Map16TileNumber` from game state: the
invisible P-switch block and coins under the blue P-switch timer, the
switch palace blocks, and the silver P-switch. The translation is code, not
a table. The player's page-1 dispatch, `CODE_00F127` (`bank_00.asm:12789`),
is reached only for page-1 tiles: the page byte's `BNE`
(`bank_00.asm:12154-12155`) and `CPY #$11` / `CPY #$6E`
(`bank_00.asm:12161-12164`) gate it, and its callers are the player's
(`bank_00.asm:12193`, `12263`, and `12479` through `CODE_00F120`, which
falls into it). It decides behavior with hardcoded comparisons (`CMP #$2F`, `#$59`, `#$5C`,
`#$5D`, `#$66`, `#$6A`, `bank_00.asm:12790-12810`), followed by
`SEC : SBC #$11 : CMP #$1D` (`bank_00.asm:12828-12831`) to index four
parallel 36-byte tables at `$00F05C`, `$00F080`, `$00F0A4` and `$00F0C8`
(`bank_00.asm:12744-12774`, read at `bank_00.asm:12846-12859`).

So vanilla behavior is range comparisons whose boundaries are immediate
operands, plus data tables indexed by `low byte - $11`. **There is no ROM
location to write that makes Map16 tile `$1A5` behave like tile `$11A`.**
Editing one of the four tables changes only page-1 tiles, and only for the
player. On a stock ROM, "reassign this block's acts-like" has nowhere to
write.

### On the corpus hacks, the table is real and locatable

Found by comparing bytes across the corpus, not from the disassembly, which
is stock and contains no hook.

Stock code calls `CODE_00F545` by `JSL` from exactly four places, each just
after a `STA Map16TileNumber`: `bank_00.asm:13351` (the player),
`bank_01.asm:2965`, `bank_02.asm:2857` and `bank_02.asm:5106`. On all four
edited hacks, all four calls are redirected; `magic` and vanilla keep them:

| call after the `STA` at | stock `JSL` | hacks' `JSL` |
| ----------------------- | ----------- | ------------ |
| `$00F4D5`               | `$00F545`   | `$86F660`    |
| `$01952C`               | `$00F545`   | `$86F700`    |
| `$029613`               | `$00F545`   | `$86F760`    |
| `$02A6E4`               | `$00F545`   | `$86F7A0`    |

GrandPooWorld_V1.2 names the same targets through bank `$06` rather than
its `$86` mirror. All four stubs open with `JSR $F608`. The shared routine,
read from Seven_Vanilla_Levels at `$86F608` (file `$37608`), does this,
simplified (it also guards on `$0D9B` to fall back to the stock routine, and
branches to a second table when the doubled index is negative): it takes
the 16-bit Map16 tile number from `$1693`, doubles it to index a table of
16-bit entries, and looks the result up again while it is `$200` or more.
The final value is written back to `$1693` as the translated tile number.

Acts-like on these ROMs is **a 16-bit value per Map16 tile, in a flat table
indexed by tile number times two, 16384 entries in one 32 KB bank**. The
entries form a redirection chain whose fixed point is below `$200`: a tile
number the stock dispatch above understands.

The table base is the long operand of the `LDA.l` at `$86F623`, so it is
read, not hardcoded. Observed bases: `$118000` (Seven_Vanilla_Levels),
`$138000` (GrandPooWorld_V1.2), `$DB8000` (Grand Poo World 2), `$DC8000`
(Invictus). All four decode as tables: tiles `$000-$1FF` map to themselves
except for a handful of author edits (0 on Seven_Vanilla_Levels, 2 on
GrandPooWorld_V1.2, 5 on Grand Poo World 2, 2 on Invictus), and on
Seven_Vanilla_Levels every entry from `$200` up reads `$0130`. The feature
is in real use. Scope: four hacks, byte comparison only, no Lunar Magic
version metadata; neither format stability across versions nor that these
four hooks are every reader of a Map16 tile number is shown.

**Verdict.** On a ROM that already carries these hooks, "reassign acts-like"
is a two-byte edit at `base + tile * 2`, and it is _not_ a per-map property:
it is per Map16 tile, so it changes that block everywhere in the ROM. On a
stock ROM the feature does not exist, and offering it would mean HackBench
installing the hooks itself, which is patching, not editing.

**HackBench today.** `readActsLikeTable` in `src/rom/ActsLikeLoader.ts` takes a `RomFile` and
returns an empty map without reading it; its comment says reading the hooked
table is a TODO. `TileFactory` falls back to the tile id for every lookup,
so `Tile.actsLike === Tile.id` for every tile of every ROM: correct on
vanilla, wrong wherever a hack's table redirects a tile.

## 4. Cloning a map into another slot

### A slot is three pointers, and one is only two bytes

| table  | address   | entry                 | evidence                        |
| ------ | --------- | --------------------- | ------------------------------- |
| L1     | `$05E000` | 3 bytes (`dl`)        | `bank_05.asm:7680`              |
| L2     | `$05E600` | 3 bytes (`dw` + `db`) | `bank_05.asm:8194`, `8700-8706` |
| sprite | `$05EC00` | **2 bytes** (`dw`)    | `bank_05.asm:8708-8720`         |

The loader indexes L1 and L2 by slot times 3 and sprites by slot times 2
(`bank_05.asm:7228-7250`). The sprite bank is not stored. Stock code writes
it as a literal: `LDA.B #$07 : STA.B SpriteDataPtr+2`, commented "All
sprite data is stored in bank 07" (`bank_05.asm:7257-7258`).

**On a stock ROM, L1 and L2 data can be relocated anywhere; sprite data
cannot leave bank `$07` without an ASM patch.** Bank `$07` is 32 KB, already
holds 24576 referenced bytes on vanilla, and its largest free run is the
unconfirmed 6289-byte tail.

All four corpus hacks carry exactly such a patch. `$05D8F5` becomes a `JSL`
to a routine that loads the bank from a 512-byte per-slot table at
`$0EF100`, where vanilla and `magic` hold `$FF` throughout
([level-table-gate.md](level-table-gate.md) has the byte trace). So on these
ROMs sprite data does leave bank `$07`: 52 to 199 slots per hack name
another bank. On Grand Poo World 2 and Invictus a further detour at
`$05D8E6` branches on live RAM, and `LevelTableGate` refuses the sprite read
there.

### Pointer sharing is the normal case

On vanilla, over all 512 slots:

| table  | distinct values | values shared by more than one slot | slots involved |
| ------ | --------------- | ----------------------------------- | -------------- |
| L1     | 194             | 22                                  | 340            |
| L2     | 34              | 16                                  | 494            |
| sprite | 177             | 29                                  | 364            |

Restricting to the 235 maps (L1 not the filler `$068000`): 63 share an L1
pointer with another map, in 21 groups. Reading sprite pointers 2 bytes
wide, 56 of the 63 share all three pointers with another map (`$015` and
`$016` do; their sprite entries are both `DP1Sprites015`,
`bank_05.asm:8730-8732`), 30 have a partner that differs in L2 or sprite,
and 7 have an (L2, sprite) pair no other map in their group has. The 63
hold 32 distinct pointer triples.

### So what does "clone" mean

Two operations, not variants of one:

**Link (repoint).** Write slot B's pointers to equal slot A's: 8 bytes on
a stock ROM, plus the bank byte at `$0EF100` on a hooked one. Needs no free
space and cannot fail. The result is _not a copy_: editing either slot edits
both. On vanilla, 56 maps already share all three pointers with another
map, and 63 share at least L1, so an editor that does not model sharing
will change maps the user did not open.

**Duplicate (copy bytes).** Allocate a free run for the L1 stream, one for
the L2 stream if its bank byte is not `$FF` (`$FF` means a background, not
objects, `bank_05.asm:32-34`), and one for the sprite stream
(in bank `$07` on a stock ROM), copy each, then write slot B's pointers.
Costs `len(L1) + len(L2) + len(sprite)` bytes and can fail for lack of
space. On vanilla the median L1 stream is 135 bytes and the largest 1204, so
the 2759-byte free run in bank `$06` holds a handful of duplicates and then
the ROM is full.

**The dangerous middle case.** Map `$016` shares L1 `$0691E5` with `$015`
and `$017`. Edit its terrain and save: repointing only `$016` silently
duplicates, and writing in place silently changes three maps. Either is
defensible, and both must be stated at the moment of the edit. That is a UI
requirement derived from a ROM fact (#178 is the sprite-pointer half of it).

## 5. Adding, removing and moving a sprite

### Format and termination

One header byte carrying sprite memory (`AND #$3F`) and buoyancy
(`AND #$C0`) settings (`bank_05.asm:7259-7264`), then 3-byte records,
terminated by `$FF` (`bank_02.asm:5253-5255`). Fixed width, no
variable-length case. Records are `YYYYEEsy / XXXXSSSS / sprite id`,
confirmed by the masks the loader applies: `AND #$0F` for the screen
(`bank_02.asm:5263`) and `AND #$F0` for the X position
(`bank_02.asm:5279`). Unlike objects, the screen is a _field_ (`SSSS` plus
the `s` bit), not a running counter, and there is no draw order.

### The stream is still sorted, and there is a hard ceiling

The loader skips sprites whose screen is below the boundary it is loading
(`CMP _1 : BCS`, `bank_02.asm:5265-5266`) and returns at the first one
beyond it (`BNE Return02A84B`, `bank_02.asm:5277`). So the stream must be
sorted ascending by screen, or later sprites never spawn. Sorting is an
invariant an editor must keep, as with objects, but here it is derivable
from each record.

The ceiling: `X` counts stream entries (`INX`, `bank_02.asm:5270`) and
indexes `SpriteLoadStatus` (`bank_02.asm:5282, 5285`), declared `skip 128`
(`rammap.asm:1968`). **A map holds at most 128 sprites**; the 129th writes
past the table into `ExitTableLow` (`rammap.asm:1969`), the per-screen
screen-exit table. That is 386 bytes of stream at most. Vanilla's longest
is 197 bytes, 65 sprites.

Hack sprite streams are only partly measured. Walked from bank `$07`, as the
2026-09-17 measurement did, they reach 2189 bytes; that was the wrong bank.
Walked from the `$0EF100` bank byte, Seven_Vanilla_Levels peaks at 236
bytes and GrandPooWorld_V1.2 at 197, both under the ceiling. Grand Poo World
2 and Invictus still read streams of several thousand bytes, consistent with
their `$05D8E6` detour loading sprite data some other way. **Unverified**
for those two; treat their sprite-stream lengths as unmeasured.

### Growth

171 of 177 vanilla sprite blocks have zero slack, so adding a sprite means
relocating the stream, on a stock ROM only inside bank `$07`. **Removing**
and **moving** a sprite are free: a delete shrinks the stream, and a move
rewrites two bytes in place as long as the screen sort holds.

## 6. Assigning a map to a launch tile

### On a stock ROM there is no launch-tile-to-slot table

Stock SMW stores no translevel numbers. It assigns them at overworld load by
walking the overworld tile array and counting. `CODE_04D7F2`
(`bank_04.asm:5263-5316`):

- zeroes `$800` bytes of `OWLayer1Translevel` and of `OWLayer2Directions`
  (`bank_04.asm:5287-5292`);
- sets a counter to 1 (`bank_04.asm:5285-5286`);
- walks all `$800` tile positions, and for each tile whose number is in
  `$56 <= t < $81` (`bank_04.asm:5297-5300`) stores the counter into
  `OWLayer1Translevel` at that position and increments it
  (`bank_04.asm:5301-5306`).

`OWLayer1Translevel` is a 2048-byte WRAM array at `$7ED000`
(`rammap.asm:2115`). The same counter indexes `DATA_04D678` to set the
tile's `OWLayer2Directions` entry (`bank_04.asm:5304-5305`), so it drives
path data too.

Three consequences on a stock ROM:

1. **A launch tile's translevel cannot be set.** There is no field to
   write. It is the tile's position among launch tiles, in tile-index order.
2. **Adding or removing a launch tile renumbers every launch tile after
   it.** Every later level changes which map it enters, and their path
   directions shift with them. A global edit disguised as a local one.
3. **The only way to point a launch tile at a different map is to move the
   map's data into the slot that tile's translevel already resolves to.**
   That is section 4's duplicate, with a fixed destination slot.

### On the corpus hacks the table is stored

All four edited hacks replace `CODE_04D7F2` with a routine that decompresses
a stored translevel table over `OWLayer1Translevel` instead of counting.
`src/rom/LmTranslevelTable.ts` reads it, and decodes a 4096-byte table on
all four. There a launch tile's translevel _is_ a writable byte, inside a
compressed block, so changing it means re-encoding and possibly relocating
that block. Renumbering is no longer forced on the rest.

### The translevel-to-slot arithmetic

Two independent gates in stock code (`bank_05.asm:7216-7226`):

```
low  byte = translevel >= $25 ? translevel - $24 : translevel
high byte = on a submap ? $01 : $00
```

The low byte is gated on the translevel and the high byte on the submap,
and neither knows about the other. So on a stock ROM the slots reachable
from the overworld are:

- main overworld: `$001` to `$0DB`
- submap: `$101` to `$1DB`

438 slots. `$000` and `$100` need translevel `$00`, which the walk produces
only if its 8-bit counter (`INC.B _0`, `bank_04.asm:5306`) wraps past `$FF`.
Slots `$0DC-$0FF` and `$1DC-$1FF` are unreachable from the overworld at any
translevel value. **Unverified:** the 438 is derived from the two gates; no ROM with a main-overworld translevel above `$24` was
tested. Vanilla reaches far fewer only because of how its own translevels
happen to be numbered and placed
([smw-overworld-levels.md](smw-overworld-levels.md)); that is data, not an
engine rule.

The `$05D8B1` hook changes the high-byte gate: its routine takes the high
byte from the translevel instead of the submap
(`LM_ENTRY_HOOK` in `src/rom/SubmapFlagGate.ts`). The reachable set on a
hooked ROM is therefore not the one above.
[smw-translevel-formula.md](smw-translevel-formula.md) reads both gates'
operands from the ROM, and `isOverworldLevel` now takes the slots the walk
actually produces rather than a fixed range.

### So what is the feature

On a stock ROM, "make an orphaned map into an entry map" means copying the
map's L1, L2 and sprite data into the slot an existing launch tile already
resolves to, overwriting that slot. Not a link: a destructive copy whose
destination the user does not choose. On a ROM with the stored table a real
assignment exists, at the cost of rewriting a compressed block.

## Open questions

| question                                                                   | what it would take                                                                                                                                                              |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Whether the 6289 unreferenced bytes at file `$3E76F` are free              | A full ROM coverage map, not just the three map pointer tables (#57).                                                                                                           |
| Why relocated L1 blocks carry a median 8 bytes of slack                    | The padding distribution across more edited ROMs; the corpus has four.                                                                                                          |
| How Grand Poo World 2 and Invictus load sprite data                        | Decode the `$05D8E6` detour ([level-table-gate.md](level-table-gate.md)).                                                                                                       |
| What HackBench must write to expand a ROM file                             | The internal header's size byte and the mapper's expectations. Not investigated.                                                                                                |
| Whether a main-overworld translevel above `$24` works on a stock ROM       | Run one. The derivation from `bank_05.asm:7216-7226` says yes; nothing tested it.                                                                                               |
| Whether the four acts-like hooks are every path that reads a Map16 tile    | Enumerate every read of the map's Map16 buffer, not just those routed through `STA Map16TileNumber`.                                                                            |
| What the compare ladder at `$86F663-$86F67C` dispatches to                 | Decode the handlers at `$86F690-$86F6E0`. The bytes show each stub comparing the value `JSR $F608` returns against immediates and branching; what each branch does is not read. |
| Whether the second acts-like table (the `LDA.l` at `$86F639`) is populated | Seven_Vanilla_Levels, Grand Poo World 2 and Invictus hold an operand there; contents not read on any ROM.                                                                       |
| Whether the acts-like table format is stable across Lunar Magic versions   | ROMs with known, differing versions; none in the corpus carries version metadata.                                                                                               |
