# Level Catalog and Classification

Status: proposal. Drafted 2026-09-13.

How HackBench should enumerate and group the levels in a ROM, vanilla or edited.

## The model

A ROM game is a catalog of levels, made accessible to the player through an
overworld. Those are two separable things, and HackBench has been conflating
them.

- **Catalog**: the level pointer tables. In SMW, 512 slots of 3 bytes each at
  `$05E000` (L1), with parallel tables for L2 and sprites. Fixed size, fixed
  location. A slot either holds real level data or points at a shared filler.
- **Access layer**: which levels the player can reach, and how. The overworld
  launches some levels; those levels lead to others through pipes, doors and
  screen exits.

The catalog is the thing a map editor edits. The access layer is a view over it.

## Three tiers

| Tier | Definition |
|---|---|
| **Maps** | An overworld tile launches this level |
| **Sub-areas** | Reachable from a Map through a screen exit, pipe or door |
| **Extras** | Real level data, not reachable from either |

Extras are not junk. In an editor they are the work-in-progress pile: levels
that exist but are not linked up yet. That is a first-class category, not a
residue.

## Why this ordering matters: it fails closed

Each tier depends on more machinery than the one above it. The catalog needs
only the pointer tables. Maps additionally need the overworld. Sub-areas
additionally need the exit graph.

When a lower tier cannot be computed, its members fall upward into Extras and
the editor still works. You lose organisation, not access.

That matters today because Lunar Magic replaces the routines that build the
overworld translevel table (see
[lunar-magic-patches.md](../lunar-magic-patches.md)). On an LM-patched ROM we
currently emit a confident level list in which entries point at the wrong
level. Falling back to "everything is an Extra" is strictly better than being
confidently wrong.

## Availability must be explicit

"Extras" means two different things and the difference is not cosmetic:

- **Not mapped yet.** We read the overworld successfully; this level genuinely
  is not linked. Useful signal for the author.
- **We could not read the overworld.** Everything is an Extra because the
  classifier is blind.

Same list, opposite meaning. A ROM with 354 unlinked levels and a ROM we cannot
classify must not look alike.

So the classifier returns availability alongside the grouping:

```ts
interface LevelClassification {
  maps: number[]
  subAreas: number[]
  extras: number[]
  overworldReadable: boolean
  exitGraphReadable: boolean
  notes: string[]     // e.g. "Lunar Magic overworld extensions detected"
}
```

The UI reports "Overworld not readable (Lunar Magic extensions)" rather than
implying orphanhood.

## Tier 1: the catalog

This is the first deliverable and it works on every ROM we have.

A slot is **real** when its L1 pointer is not the filler pointer. The filler is
computed per ROM as the most frequent L1 pointer across all 512 slots, not
hardcoded: it is `$068000` on vanilla but must not be assumed.

Measured across the corpus:

| ROM | distinct L1 ptrs | filler slots | real | parseable |
|---|---|---|---|---|
| vanilla | 194 | 277 | 235 | 235 |
| magic (copier header) | 194 | 277 | 235 | 235 |
| Seven Vanilla Levels | 214 | 261 | 251 | 251 |
| GrandPooWorld 1.2 | 199 | 277 | 235 | 235 |
| Grand Poo World 2 | 264 | 221 | 291 | 291 |
| Invictus 1.0 | 320 | 158 | 354 | 354 |

The two 4 MB ROMs originally parsed only part of their catalog: 197 of 291 and
192 of 354. The suspected cause was expanded-ROM addressing, where bank bytes
at or above `$80` are LoROM mirrors in a 512 KB ROM but real banks in a 2 MB or
4 MB one. That fix landed separately and closed both gaps exactly, so every ROM
in the corpus now parses in full. The hypothesis is confirmed, not merely
plausible.

The tier still reports what it can and cannot parse rather than silently
dropping slots, because that property is what made the gap visible in the first
place.

### What Tier 1 replaces

`SmwRom.classifyLevels()` currently returns `{ overworld, subarea }` by range
check plus `levelHasObjects()`, and dedupes by L1 pointer. Three defects follow:

1. `levelHasObjects()` returns true for filler slots, so filler enters the list
   (`$012` and `$112` both do on vanilla).
2. Dedup by L1 pointer alone merges slots that differ in L2 or sprite data,
   which are different levels (`$015` and `$017` on vanilla).
3. The range check admits `$000`, which no overworld tile can reach.

Three providers consume it: `RomExplorerProvider`, `LevelGraphProvider`,
`RomStatsProvider`. Tier 1 is additive; migrating those callers is a separate,
deliberate step, not a side effect.

## Tier 2: Maps

Requires reading the overworld tilemap and resolving tiles to level indices.

Works on vanilla. Blocked on LM-patched ROMs, where the routine that assigns
translevel numbers is replaced by one that decompresses a precomputed table.
The table is reachable: a 3 byte pointer at `$04D803` / `$04D808` inside the
patched routine, LC_LZ2 compressed, decompressing to 4096 bytes. Verified with
this repo's own `src/rom/LcLz2.ts` on two of the four hacked ROMs; the other two
are 4 MB and need the expanded addressing fix first.

Detection is a single byte: `$05D8B1` holds `$22` (JSL) in a patched ROM and
`$F0` (BEQ) in a stock one.

### Resolved: does Map16 tile `$5A` ever start a map?

No. The count is 77 entry maps, not 79, and slots `$016` and `$108` are
correctly excluded. This decided a dispute that ran two review rounds, so the
evidence is recorded here rather than left in a code comment.

All figures below are read from `Super Mario World (USA).vanilla.sfc`, one
cart, this revision, plus the identical headered copy. The four carts with a
rebuilt overworld fail closed before any of this runs and are not oracles for
it; their swap tables were read anyway and all four still pair `$5A -> $5F`.

Every pristine `$5A` tile, its buffer index in `OWL1TileData`, and the two
independent per-position tables that both call it a star-warp node:

| buf | half | (x,y) | translevel | slot | `DATA_04D85D` event(s) | warp SRC | warp DST | slot L1 is real |
|-----|------|-------|-----------|------|------------------------|----------|----------|-----------------|
| `$1F0` | 0 | (16,15) | `$12` | `$012` | 96 | 16 | 17 | no, filler |
| `$227` | 0 | (7,18) | `$16` | `$016` | 19 | 6 | 13 | yes, shared with `$015`/`$017` |
| `$304` | 0 | (20,16) | `$1E` | `$01E` | 53 | 18 | 19 | no, filler |
| `$4E0` | 1 | (0,14) | `$2C` | `$108` | 30, 81, 82 | 14 | 15 | yes, unique pointer |
| `$534` | 1 | (20,3) | `$30` | `$10C` | 63, 90, 91 | 25 | 21 | no, filler |
| `$711` | 1 | (17,17) | `$48` | `$124` | 108 | 24 | none | no, filler |
| `$787` | 1 | (23,24) | `$55` | `$131` | 94 | 22 | 23 | no, filler |

"warp SRC" is the index into `DATA_048431` / `DATA_048467` (`bank_04.asm:491`,
`:500`) whose submap and tile position equal this tile's. Those are the tables
`CODE_048509` (`bank_04.asm:527`) searches, and it is only called from the
`$5F` branch and the `$82`/`$5B` branch of `OWPU_ABXY` (`bank_04.asm:1756`,
`:1773`). "warp DST" is the index into `DATA_04849D` / `DATA_0484D3`
(`bank_04.asm:509`, `:518`) that lands on this tile, decoded per
`CODE_04853B` (`bank_04.asm:554-581`).

The `$711` gap in the DST column is the whole reason an earlier review read
this as "six of seven". It is not a seventh tile that behaves differently.
All 27 warp entries account for exactly:

- 12 entries on `$82` pipe tiles, in 6 reciprocal pairs;
- 13 entries on the 7 `$5A` and 6 `$5F` tiles, in 6 reciprocal pairs plus
  entry 24, whose reciprocal is entry 26;
- entries 20 and 26, whose source positions hold tiles `$00` and `$56`. Those
  are the two tiles the disabled debug warp at `bank_04.asm:1732-1735` tested
  for, which the `BRA +` at `:1730` skips. Entry 26 is therefore dead, which
  is what leaves entry 24 one-way and `$711` with no live destination.

So the source table covers 7 of 7, not 6 of 7, and the destination table is
the weaker oracle: `OWPU_ABXY` never consults it.

What the cart does not settle: whether every one of those events is actually
triggered in normal play. Event activation lives in save state, not in ROM, so
a static read cannot prove a `$5A` is always swapped before a player reaches
it. The answer does not depend on that, because 5 of the 7 slots a `$5A` tile
would name hold this cart's filler L1 pointer, against 2 of the 79 tiles that
do start a map. A cart does not put 5 of 7 level entrances on empty slots.

The two slots that would flip the count if the rule were wrong:

- `$016` is byte-identical to `$015` on all three pointers: L1 `$0691E5`, L2
  `$FFDE54`, sprite `$C6D5`. Checked on all three deliberately, because the
  Tier 1 notes above warn that L1-only dedup merges slots that really differ
  (`$017` shares the same L1 and sprite pointers but has its own L2). `$016`
  holds no distinct level data.
- `$108` does hold a unique L1 pointer and is an orphaned map under this rule.
  `buildLevelExitGraph` reports no screen exit reaching it, but that graph is
  the broken one described under Tier 3, so treat that as weak.

Both are endpoints of fully reciprocal star-warp pairs (6 with 13, and 14 with
15), which makes them the two least likely `$5A` tiles to be level entrances,
not the most likely.

## Tier 3: Sub-areas

Requires the exit graph, which is currently broken: `buildLevelExitGraph`
derives destinations from RAM the game never reads, and 54 of its 88 edges are
invalid on vanilla. Tracked in issue #308. Tier 3 should not be built until that
is fixed.

## Non-goals

- Matching any particular level count. Vanilla SMW is documented as having 72
  overworld-launched levels and 96 exits; our own derivation of overworld
  entrances gives 77 under a defensible rule. Those answer different questions,
  and the 96-exit figure comes from a save-file counter, not from the level
  tables. The classifier reports what the ROM contains; it does not aim at a
  number.
- Supporting non-SMW games. The tier model generalises, the tables do not.

## Open questions

1. ~~Expanded-ROM addressing: what is the correct SNES-to-file mapping for 2 MB
   and 4 MB ROMs, and does it explain the parse failures above?~~ Resolved: yes.
   One LoROM formula with exclusions for WRAM and the register window; both
   4 MB ROMs went to a full parse.
2. Should Extras be sub-divided further, for example levels reachable only from
   another Extra?
3. When the overworld is unreadable, should Maps be empty or absent? Empty
   implies "none"; absent implies "unknown".
