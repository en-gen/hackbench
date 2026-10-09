# SMW Overworld Level Mapping

Every claim below is cited to `C:\Projects\SMWDisX`. Rows still sourced only to
`docs/memory-map.html` are labelled as such, because that provenance has now
produced four separate errors in this file (see [Provenance](#provenance)).

## Translevel Number System

SMW uses a **translevel number** (`$00`-`$5F`) to identify an overworld level
tile. The translevel of the tile being entered is stored at WRAM `$7E:13BF`
(`TranslevelNo`, written at `bank_05.asm:7215`).

### Conversion: translevel to L1 pointer table index

Traced to `bank_05.asm:7217-7226`:

```
CODE_05D8A2:
    CMP.B #$25          ; \
    BCC +               ; | if translevel >= $25,
    SEC                 ; |
    SBC.B #$24          ; / subtract $24
  + STA.W LoadingLevelNumber
    STA.B _E                                  ; low byte
    LDA.W OWPlayerSubmap,Y
    BEQ +
    LDA.B #$01                                ; high byte = 1 on a submap
  + STA.B _F
```

So `room = (translevel >= $25 ? translevel - $24 : translevel) | (onSubmap ? $100 : 0)`.

The high byte comes from `OWPlayerSubmap` (`$7E:1F11`), **not** from the
translevel. The shorthand `+$DC` is only correct because every translevel above
`$24` happens to sit on a submap in vanilla. A romhack can break that, so read
the submap flag.

| Translevel Range | Map Area  | Pointer Table Index | Count |
|------------------|-----------|---------------------|-------|
| `$00`-`$24`      | Main map  | `$000`-`$024`       | 37    |
| `$25`-`$5F`      | Submaps   | `$101`-`$13B`       | 59    |
| **Total**        |           |                     | **96**|

That 96 is the numbering capacity of the table, not a count of anything that
exists. See [Two different 96s](#two-different-96s).

### Level pointer table ranges

| Index Range   | Purpose                                                      |
|---------------|--------------------------------------------------------------|
| `$000`-`$024` | Main overworld levels (directly accessible)                  |
| `$025`-`$0FF` | Secondary exits (doors, pipes, subareas, bonus games)        |
| `$100`        | Often unused or special                                      |
| `$101`-`$13B` | Submap levels, directly accessible                           |
| `$13C`-`$1FF` | More secondary exits, unused slots                           |

## `OWLevelTileSettings` (`$7E:1EA2`), 96 bytes, one per translevel

`rammap.asm:2047`. Every read and write of this table in the disassembly was
enumerated (23 sites, all banks) before writing this section.

| Bits  | Mask  | Meaning                                 | Cited at |
|-------|-------|-----------------------------------------|----------|
| 0-3   | `$0F` | Path directions unlocked from this tile | `bank_04.asm:2117`, `2439-2441`, `1918-1919` |
| 4-5   |       | **Never read or written anywhere**      | exhaustive grep, see below |
| 6     | `$40` | Midway point reached                    | `bank_04.asm:1447-1449`, `bank_05.asm:7363-7366` |
| 7     | `$80` | Level beaten                            | `bank_04.asm:1462-1465` |

### The low nibble is a direction set, not exit flags

The write side is `DATA_04941E` (`bank_04.asm:2117`):

```
DATA_04941E: db $08,$00,$04,$00,$02,$00,$01,$00
```

ORed into the tile's byte at `bank_04.asm:2439-2441` and again at `2777-2779`,
indexed by a direction index that has been reversed with `EOR.W #$0002`
(`bank_04.asm:2432`). The read side masks with `$000F` (`bank_04.asm:1918-1919`).
Written values are `$01`, `$02`, `$04`, `$08`; the test mask is `$0F`. Bits 0-3.

The per-direction meaning is fixed by the new-file initialiser
`InitLevelTileMovementData` (`bank_00.asm:3853-3861`), the only place a direction
mask appears next to a named direction:

| Bit | Mask  | Direction | Initialiser entry |
|-----|-------|-----------|-------------------|
| 0   | `$01` | right     | `db $4D,$01` "enable right on special world star warp" |
| 1   | `$02` | left      | `db $5C,$02` "enable left on star world bottom right star warp" |
| 2   | `$04` | down      | `db $57,$04` "enable down on star world right star warp" |
| 3   | `$08` | up        | `db $5B,$08` "enable up on star world bottom left star warp" |

Yoshi's House (`$28`) is initialised to `$03`, left plus right
(`bank_00.asm:3854`), which matches a tile you can only leave sideways.

### There is no "has a secret exit" bit here

Bits 0-5 were previously documented as "normal exit beaten" (`$01`), "secret
exit beaten" (`$02`) and a four bit path field starting at bit 2. That layout
does not exist. **Nothing in this table records how many exits a level has, or
which one was taken.** Any analysis that reads such a bit is reading a field the
ROM never writes.

Bits 4 and 5 are claimed unwritten on the strength of an exhaustive grep for
`OWLevelTileSettings` across the whole disassembly: 23 hits, of which the masks
used are `$0F`, `$40`, `$80`, plus the two fixed-index reads `+$48` and `+$49`
described below. No site touches `$10` or `$20`.

### Two fixed-index reads

Translevel `$49` and `$48` are read by index, testing bit 7 (level beaten):

| Site | Reads | Effect |
|------|-------|--------|
| `bank_00.asm:5405-5409` | `+$49` | post-Special-Zone graphics file swap |
| `bank_00.asm:5739-5741` | `+$48` | selects `OWSpecialColors` over `OverworldColors` |
| `bank_01.asm:3329`, `7895`; `bank_02.asm:5464`; `bank_0C.asm:3379` | `+$49` | post-Special-Zone sprite palette and tilemap changes |

These are hardcoded translevel indices in the vanilla ROM, so they are a
hack-fragility point: a romhack that renumbers the Special Zone still runs this
code against `$48`/`$49`.

### Persistence

`OWLevelTileSettings` through `ExitsCompleted` is one contiguous 141 byte block
(`$7E:1EA2`-`$7E:1F2E`) mirrored to `SaveDataBuffer` (`$7E:1F49`-`$7E:1FD5`):

- Load: `CopyFromSaveBuffer` copies `$8C + 1 = 141` bytes (`bank_00.asm:4365-4373`).
- Save: only the 96 tile-settings bytes are copied by the overworld save prompt
  (`LDX #$5F`, `bank_04.asm:1579-1583`); events and player state are copied
  separately (`LDX #$2C`, `bank_04.asm:1483-1487`).
- New file: `InitSaveData` zeroes the whole buffer, then applies the eight
  `InitLevelTileMovementData` pairs (`bank_00.asm:3873-3884`).

## Exit counting

This is the ROM's own definition of "an exit worth +1".

### The counter

`ExitsCompleted` (`$7E:1F2E`, `rammap.asm:2058`) is the live counter. It is the
last byte of the 141 byte save block, so it lands on `SaveDataExitCount` in SRAM
(`rammap.asm:2146`, at offset `!SaveFileSize - 3 = 140`). The file select
compares it against `!TotalExitCount` to decide whether to draw the star
(`bank_00.asm:3625-3631`).

**There is exactly one write site in the whole disassembly:**

```
bank_04.asm:6712-6728
    LDA.W OverworldEventProcess
    BEQ +                          ; only when an event sequence was running
    STZ.W OverworldEventProcess
    INC.W OverworldProcess
    LDA.W OverworldEvent
    AND.B #$07
    TAX                            ; bit within byte
    LDA.W OverworldEvent
    LSR A : LSR A : LSR A
    TAY                            ; byte index
    LDA.W OWEventsActivated,Y
    ORA.L DATA_04E44B,X            ; mark the event activated
    STA.W OWEventsActivated,Y
    INC.W ExitsCompleted           ; <- the only increment
    STZ.W CreditsScreenNumber
  + RTS
```

No decrement exists. So:

> **One exit equals one overworld event number becoming activated for the first
> time.** Not one goal tape, not one level, not one map.

### The gate chain

The increment lands in the save file only when every step passes.

1. **Level load** sets the level's base event:
   `OverworldEvent = DATA_05D608[TranslevelNo]` (`bank_05.asm:7358-7360`),
   guarded by `SublevelCount == 0` so only the entry map sets it.
2. **Level end** sets `OWLevelExitMode` and bumps `CreditsScreenNumber`
   (see [How each exit sprite ends a level](#how-each-exit-sprite-ends-a-level)).
3. **Back on the overworld**, `CODE_04E5EE` (`bank_04.asm:6257-6277`):
   - `OWLevelExitMode == 2` gives `INC OverworldEvent`, so a secret exit awards
     `base + 1`.
   - `CreditsScreenNumber == 0` skips everything. No level was beaten.
   - `OverworldEvent == $FF` skips everything. The translevel has no event.
   - the event bit already set in `OWEventsActivated` skips everything. **A
     re-beaten exit awards nothing.**
4. The event animation runs, and on completion the increment above fires.

`OWEventsActivated` is 15 bytes (`rammap.asm:2048`) holding one bit per event;
`DATA_04E44B` (`bank_04.asm:6062`) is the eight entry bit-mask table.

### The event space is exactly `$00`-`$6E`

`bank_04.asm:5310-5315` walks every event number once:

```
    STZ.B _F
  - JSR CODE_04DA49
    INC.B _F
    LDA.B _F
    CMP.B #$6F
    BNE -
```

That is 111 events, `$00` through `$6E`.

`DATA_05D608` (`bank_05.asm:7016-7028`) holds 93 bytes, one per translevel
`$00`-`$5C`; translevels `$5D`-`$5F` fall past the table into filler. Reading
those 93 bytes:

- 7 entries are `$FF` (no event).
- 86 entries are real, and **all 86 are distinct**.

  `docs/glossary.md` also says 86, for "launch tiles that enter a level". That
  agreement is probably a coincidence of two different quantities, and is an
  open discrepancy: walking the overworld tile stream yields 92 launch tiles, 79
  that start a map and **77 entry maps**, not 86. 86 is the count of translevels
  carrying an event, which is not the same set. One of the two needs correcting
  and this file does not yet know which.
- The 25 event numbers in `$00`-`$6E` that are not any translevel's base event
  are each exactly `base + 1` of some translevel. The 86 base events and those
  25 successors tile `$00`-`$6E` with no gaps and no overlaps.

So the ROM reserves 86 normal-exit events plus 25 secret-exit slots. **Whether a
given level actually has a secret exit is not recorded in this table.** A slot
existing only means no other level claimed the number. The answer lives in the
level's sprite stream, below.

### How each exit sprite ends a level

`OWLevelExitMode` (`$7E:0DD5`, `rammap.asm:1386`): `$01` normal, `$02` secret,
`$00` no exit awarded.

| Sprite | Handler | Sets | Awards an exit? |
|--------|---------|------|-----------------|
| `$7B` goal tape | `GoalTape`, `bank_01.asm:8833-8836` | `SecretGoalTape = extraBits >> 2`, then mode `= SecretGoalTape + 1` at `bank_00.asm:8532-8552` | yes: normal if extra bits 0, secret if extra bits 1 |
| `$0E` keyhole | `Keyhole`, `bank_01.asm:13209`; completes at `bank_00.asm:7858-7861` | `LDA #$02`, hardcoded | yes, always secret |
| `$4A` goal sphere ("question sphere") | `GoalSphere`, `bank_01.asm:1104-1119` | `EndLevelTimer = $FF`, then `LDA #$01` at `bank_00.asm:8470-8473` | yes, always normal |
| boss defeat | e.g. `bank_03.asm:79-85` | same `EndLevelTimer` path, `LDA #$01` | yes, always normal |
| switch palace | `bank_05.asm:3246-3251` | `INC CreditsScreenNumber`, mode `$01` | yes, always normal |
| `$8C` side exit (walk off the right edge) | `SideExit` (`bank_01.asm:1245`) into `SideExitMain` (`bank_02.asm:15506`), which sets `SideExitEnabled` at `bank_02.asm:15515-15516`; fires at `bank_00.asm:11773-11780` | `SubSideExit` stores mode `$00` and does **not** touch `CreditsScreenNumber` (`bank_05.asm:3258-3264`) | **no** |
| `$8D` ghost house exit sign and door | `GhostHouseExit` (`bank_01.asm:1193`) into `GhostExitMain` (`bank_02.asm:15639`) into `CODE_02F5D0` (`bank_02.asm:15670-15710`) | nothing. The handler writes 10 OAM entries and returns | **no.** It is scenery |

There is no top-edge or bottom-edge exit sprite. Grepping the whole of
`bank_01.asm` for "exit" returns two entries in the sprite main pointer table,
`$8C` at `bank_01.asm:1038` and `$8D` at `1039`, and `SideExitEnabled` has a
single write site (`bank_02.asm:15516`) and a single read site, which tests
`PlayerXPosScrRel >= $00FA` (`bank_00.asm:11775-11779`). That is a right-edge
test. Nothing tests a vertical screen boundary for a level exit.

The `$8D` row is worth dwelling on. It was written into an earlier draft of this
file as "reaches the `EndLevelTimer` path, awards a normal exit" on the strength
of its name, without reading `CODE_02F5D0`. The handler is pure OAM drawing. The
exit in a ghost house comes from the goal tape in the same sprite list, and the
door you walk into is a Map16 screen exit, not this sprite.

Two special cases in the same routine (`bank_00.asm:8553-8566`): when
`CutsceneID` is set, translevel `$13` gets `INC OWLevelExitMode` (its boss clear
is promoted to a secret exit), and translevels matching `DATA_00C9A7` route to
game mode `$18` instead of `$0B`.

### What this means for "how many exits does this map have?"

A map's exit count is **not** the number of exit sprites it contains. Two goal
tapes on one map are two exits only if their extra bits differ; two normal goal
tapes award the same event twice, and the already-activated check rejects the
second one. The ROM-readable rule is:

```
normalExit  = level chain contains sprite $7B with extra bits 0,
              or sprite $4A, or a boss, or is a switch palace
secretExit  = level chain contains sprite $0E,
              or sprite $7B with extra bits 1
exits       = (normalExit ? 1 : 0) + (secretExit ? 1 : 0)
```

"Level chain" means the entry map and every sub area reachable from it, because
a keyhole or a secret goal tape may sit in a sub area rather than the entry map.
A per-map sprite scan that ignores sub areas misattributes them.

### Sprite census on the vanilla ROM

Counts from walking every level's sprite stream via the pointer table at
`$05:EC00`. Labels are the disassembly's own names from `Ptrs05EC00`. Scope: one
scan of `Super Mario World (USA).vanilla.sfc`, 2026-09-21. These are level IDs
with the sprite present, **not** exit counts, for the reasons above.

| Sprite | Levels | Notes |
|--------|--------|-------|
| `$8C` side exit | 2 | `$003` (`TSA`) and `$104` (`YH`) |
| `$4A` goal sphere | 1 | `$0F7` (`SGSSub2`) |
| `$0E` keyhole | 20 | |
| `$7B` goal tape | 66 | extra bits not distinguished by this scan |
| `$8D` ghost house sign | 8 | every one of the 8 also carries `$7B` |

The `$8C` result is the useful one. Exactly two levels in the ROM can be left
by walking off the right edge, and the ASM says that path awards nothing. Those
two are the Top Secret Area and Yoshi's House, neither of which counts toward
the exit total. The ROM scan and the `SubSideExit` trace agree.

The `$7B` count of 66 is larger than the number of goal tapes, because several
level IDs share one sprite list: `SubNormalExit` alone is the sprite data for 9
of them. Counting level IDs is not counting exits.

### The 96 is a threshold, not a total

`!TotalExitCount = 96` (`constants.asm:52`) is used once, as
`CMP #!TotalExitCount / BCC .NoStar` (`bank_00.asm:3628-3629`). It is a
greater-or-equal threshold for drawing the star next to the file. The counter
itself is drawn by `HexToDec` on the raw byte (`bank_00.asm:3636`), so a hack
whose event graph yields 120 exits would display 120, with a star. **The ROM
never derives a total; it asserts a target.** Do not treat 96 as an oracle for
anything HackBench computes.

### The vanilla counts, derived

`test/suite/integration/vanillaCounts.test.ts` computes these from the ROM.

**Exits close exactly at 96.**

```
exits = entry maps awarding a normal exit  (74)
      + entry maps with a secret exit      (22)
      = 96
```

**The level count does not close, and this file does not pick one.** The ROM
supports several defensible answers:

| Quantity | Value | What it is |
|----------|-------|------------|
| launch tiles | 92 | tiles the overworld hands a translevel, `bank_04.asm:5297-5300` |
| tiles starting a map | 79 | minus 6 star warps (`$5F`) and 7 tiles an event swaps to `$5F` (`$5A`) |
| entry maps | 77 | minus 2 naming a filler L1 pointer |
| distinct level data | 76 | `$015` and `$017` share an L1 pointer **and** a sprite pointer: one level, two launch tiles |
| awarding a normal exit | 74 | minus Top Secret Area (`$003`, event `$FF`), `$017` (event `$FF`) and Yoshi's House (`$104`, side exit only) |

Switch palaces are levels and are not subtracted from any row above.

**The 76 has an independent external match.** The Super Mario Wiki's
[Super Mario World](https://www.mariowiki.com/Super_Mario_World) article states
"nine worlds and 73 levels (76 including Yoshi's House and the Top Secret Area
and if the Back Door and Front Door are counted as separate levels)". Its 76 and
the 76 derived above agree, arrived at independently: this file gets there by
deduplicating `$015`/`$017` out of 77 entry maps, and never consulted the
article while doing so.

That is an external editorial source, not ASM, so it is a cross-check and not a
citation. It is recorded because it is the only external figure in this
investigation that matched a ROM quantity without being fitted to.

**73 is 76 minus three stated conventions**, not a quantity the ROM computes:

```
76  distinct level data
-1  Yoshi's House
-1  Top Secret Area
-1  Front Door and Back Door merged into one level
=73
```

Two of those three are levels this file already identifies as awarding nothing.
There is no algorithm from the ROM that yields 73, and looking for one is what
produced the retracted switch-palace rule below.

The same article puts the exit total at "96 to 100, depending on how one counts
the levels". The ROM has no such ambiguity: `ExitsCompleted` increments once
per overworld event first activated, which is a single well-defined quantity,
and it gives exactly 96.

An earlier revision of this file defined `levels = entryMaps - switchPalaces`
to reach 73. That was fitting an algorithm to a target: the four switch palaces
are not excluded by any rule the ROM states, they merely happened to number
four. It is recorded here because it is precisely the defect class this repo
keeps producing, and it passed a green test while being wrong.

Pipes, star warps and the tiles that only move the player around the overworld
drop out by construction, because they never become entry maps.

**Two parts of the 96 are not traced, and the test source says so.**

- ~~`ORPHAN_SECRET_ROOMS` is a hardcoded `[$0EB, $1E7]`.~~ **Fixed.** Those two
  rooms were unreachable in `buildLevelExitGraph`, so the count needed them
  added by hand. They are now found by the chain walk like any other secret
  exit, the constant is gone, and the total did not move. That the hardcode
  became redundant rather than wrong is the check that the fix was real.

  The root cause was in `buildLevelExitGraph`, which sourced its destination set
  from `classifyLevels().subarea`. That carries two defects `MapTree.ts` already
  documents and routes around:

  - `classifyLevels` dedupes by L1 pointer, so a slot sharing a pointer with an
    earlier slot lands in neither returned list. Sharing L1 data is a space
    optimisation, not identity: the secondary-exit table names a **slot**. On
    vanilla, `$0EB`'s pointer is shared by `$0F0`, `$0FB`, `$1DA`, `$1E7` and
    `$1F9`; one was kept and four discarded.
  - it gates on `levelHasObjects()`, through its `data[5] === $FF` terminator rule (issue #695), which rejects 24
    real rooms.

  Between them, 47 of the ROM's 235 real maps could never be a destination.
  `buildLevelExitGraph` now takes its map universe from pointer identity, the
  same test `buildLevelCatalog` applies, and orphans fall from **59 to 26**.

  The remaining 26 were then identified and are **not damage**. Each is an
  eligible destination that no screen exit points at, and 24 of them are entered
  by game mode or a special flag, which a screen-exit graph cannot model and
  should not pretend to. Named from the sprite pointer table's own labels
  (`Ptrs05EC00`, `bank_05.asm`, index `i` at line `8709 + i`):

  | Slots | What | Entered by |
  |---|---|---|
  | `$093`-`$09B`, `$193`-`$19B` (18) | Lemmy, Wendy, Reznor, Larry, Iggy, Ludwig, Roy, Morton and Bowser "Copy" scenes | game mode `$23`, `GM23PrepEnemyList` (`bank_00.asm:2508`), indexed by `CreditsScreenNumber` |
  | `$000`, `$100` (2) | Bonus Games | `BonusGameActivate` (`bank_00.asm:8540`) |
  | `$0C5` (1) | intro | game mode |
  | `$0C7` (1) | title screen | game mode |
  | `$0C8`, `$1C8` (2) | Yoshi Heaven | `YoshiHeavenFlag` (`bank_00.asm:5009`) |
  | `$016` (1) | a third copy of `DP1Sprites015` that no launch tile starts | nothing |
  | `$108` (1) | `TestLevelSprites`, unused | nothing |

  So exactly **two** slots in the ROM are genuinely unreferenced, and both are
  leftovers rather than defects. Every map reachable in normal play is reachable
  in the graph. `test/suite/integration/exitGraphReach.test.ts` pins the full
  classification, so a map that stops being reachable fails there by name rather
  than by a count moving.

  Re-measured on the fixed graph, the earlier "no sub area is shared between two
  entry maps" is overturned. **Front Door (`$10D`) and Back Door (`$10E`) do
  converge**, at `$1C7`, which was itself one of the orphans. The ROM has
  exactly two entry-map pairs that share any sub area:

  | Entry maps | Shared | Why |
  |---|---|---|
  | `$015` `$017` | `$0E3`, `$0FD` | same L1 **and** sprite pointer, so identical exits. One level reached twice, not two levels meeting |
  | `$10D` `$10E` | `$1C7` | different level data, genuinely converging on the Bowser room |

  Only the second is a real convergence. Both are pinned in
  `exitGraphReach.test.ts`.
- Whether the 21 boss and switch-palace entry maps award a normal exit is
  inferred from "has an event and is not side-exit-only", not traced to the
  handlers that write `EndLevelTimer`.

The event space holds 111 slots, so 96 sits well inside it. Yoshi's House holds
event `$00` and can never award it.

## Two different 96s

These coincide numerically and are otherwise unrelated. Conflating them is the
trap this file previously set.

| Quantity | Value | What it is | Source |
|----------|-------|------------|--------|
| `OWLevelTileSettings` size | 96 bytes | the overworld's translevel numbering capacity, `$00`-`$5F` | `rammap.asm:2047` |
| `!TotalExitCount` | 96 | the star threshold on the file select screen | `constants.asm:52`, `bank_00.asm:3628` |

Neither is a count of levels. Per `docs/glossary.md`, 92 launch tiles carry a
translevel and 86 enter a level, and a level with two exits occupies one
translevel. `DATA_05D608` independently agrees: 86 non-`$FF` entries.

A third near-96 quantity that is also unrelated: the event space holds 111 slots
(`$00`-`$6E`, `bank_04.asm:5310-5315`).

## Secondary exit destination tables

Four parallel 512 entry tables in bank `$05`, indexed by
`(submapFlag << 8) | exitByte`. Read at `bank_05.asm:7117-7161`:

| ROM Address | Label | Contents |
|-------------|-------|----------|
| `$05:F800` | `DATA_05F800` (`bank_05.asm:9482`) | destination level number, low byte, into `LoadingLevelNumber` |
| `$05:FA00` | `DATA_05FA00` (`bank_05.asm:9547`) | low nibble indexes the Y position tables `DATA_05D730`/`DATA_05D740` |
| `$05:FC00` | `DATA_05FC00` (`bank_05.asm:9612`) | X position / screen |
| `$05:FE00` | `DATA_05FE00` (`bank_05.asm:9677`) | `AND #$07` gives `LevelEntranceType` |

The previous version of this file shifted these rows by one and described them
as midpoint entrance tables. They are the secondary exit destination tables, the
same set the exit graph reads. Midpoints do not use separate L1 pointer slots.

The *primary* entrance tables, used when `UseSecondaryExit == 0`, are a different
set: `DATA_05F000`, `DATA_05F200`, `DATA_05F400`, `DATA_05F600`
(`bank_05.asm:7268-7336`), indexed by level number.

## Key ROM Addresses

| Address   | Description | Status |
|-----------|-------------|--------|
| `$05:E000`/`E200`/`E400` | L1 pointer table, lo/hi/bank, 512 entries | from `memory-map.html`, not re-verified here |
| `$05:E600` | L2 pointer table, lo/hi/bank | from `memory-map.html`, not re-verified here |
| `$05:EC00`/`EE00`/`F000` | Sprite pointer table, lo/hi/bank | `$05:F000` collides with the primary entrance table label `DATA_05F000` (`bank_05.asm:9222`); one of the two is mislabelled and this is unresolved |
| `$05:D608` | `DATA_05D608`, event number per translevel, 93 entries | verified, `bank_05.asm:7016` and `7359` |
| `$05:D760` | `DATA_05D760`, six level-mode values paired with the entrance routine long pointers at `$05:D766` | **corrected.** Previously documented as a "GFX tileset ID lookup `[spriteSet] -> tilesetId`", which it is not. See `bank_05.asm:7054-7060` and the match loop at `7404-7413` |
| `$04:D678` | `DATA_04D678`, one byte per translevel, copied into the per-tile direction buffer during overworld Layer 1 decode | verified, `bank_04.asm:5148` and `5296-5306` |
| `$04:9964`/`9966`/`9968` | star warp source: Y pos, X pos, submap. Three stride-2 views of one block, index counting down from `$41` by 2 | **corrected.** Previously "5 bytes/entry". See `bank_04.asm:2846-2858` |
| `$04:99AA`/`99AC`/`99AE` | star warp destination: Y pos, X pos, submap | verified, `bank_04.asm:2859-2865` |
| `$04:99F0`/`99F1` | star warp destination scroll pointers, separate index held in `_2` | verified, `bank_04.asm:2866-2872` |
| `$00:9EE0` | `InitLevelTileMovementData`: eight `[translevel, directionMask]` pairs applied to a new save file | **corrected.** Previously "Initial level flags for `$1EA2`", which overstates it. The masks only ever set bits 0-3. See `bank_00.asm:3853-3861` |

## Provenance

The bit layout this file previously carried for `$1EA2` came from
`docs/memory-map.html` rather than from ASM. That is the citation gap
`CLAUDE.md` exists to close, and the same source produced three further errors
found while checking it: `$05:D760`, the secondary exit table row alignment, and
the `$00:9EE0` description.

## Evidence scope

Everything above was read from `C:\Projects\SMWDisX` on 2026-09-21 in one
session, against the U version (`ver_is_console` and `ver_is_english` branches).
The claim that bits 4 and 5 of `$1EA2` are never touched, and the claim that
`bank_04.asm:6727` is the only write to `ExitsCompleted`, each rest on an
exhaustive grep of the disassembly for the symbol, not on a sampled read. The
86/25/111 event partition was computed from the 93 bytes of `DATA_05D608` as
they appear in the disassembly source.

The sprite census is the one section derived from ROM bytes rather than from the
disassembly: a single scan of `Super Mario World (USA).vanilla.sfc` on
2026-09-21, no other ROM, no repeat run.

No claim here was checked against a running ROM, and none was checked against an
edited ROM. Per `CLAUDE.md`, a romhack can replace the routines traced above; in
particular `CODE_04E5EE` and the increment at `bank_04.asm:6727` are ordinary
code, and a hack may relocate or bypass them.

## Level names and ids

- The ROM holds a level name table at `$04A0FC` (96 entries x 2 bytes); `src/rom/SmwLevelNames.ts` decodes it (`decodeLevelName`, `getAllLevelNames`, `getLevelNameByIndex`). `[EST]`
- Three external lists (a forum post, two LLM tables) were refuted against the ROM in one session, each claiming 76 entries and disagreeing, with entries at `$019`, `$01E`, `$112` pointing at the shared filler L1 `$068000`. `[EST]`
- Report ids as `$XXX` hex. Add a name only when it comes from the decoder or the owner said it that turn; leave unverified names off.
- Confirmed by the owner 2026-09-13: Yoshi's House `$104`, Valley Fortress `$111`, Red Switch Palace `$11B`. `[EST]`
- Decoded, not separately confirmed: Green Switch Palace `$008`, Yellow `$014`, Blue `$121`. `[EST]`
- `levelHasObjects()` is true for filler slots (`$012`, `$112`). Test a real slot by comparing its L1 pointer with the most frequent (filler) pointer. `[EST]`
