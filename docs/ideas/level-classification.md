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
| Grand Poo World 2 | 264 | 221 | 291 | 197 |
| Invictus 1.0 | 320 | 158 | 354 | 192 |

The two 4 MB ROMs parse only part of their catalog. The likely cause is
expanded-ROM addressing: bank bytes at or above `$80` are LoROM mirrors in a
512 KB ROM but real banks in a 2 MB or 4 MB one. That is a separate fix and it
is tracked as such; the catalog tier should report what it can parse and what it
cannot, rather than silently dropping slots.

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

1. Expanded-ROM addressing: what is the correct SNES-to-file mapping for 2 MB
   and 4 MB ROMs, and does it explain the parse failures above?
2. Should Extras be sub-divided further, for example levels reachable only from
   another Extra?
3. When the overworld is unreadable, should Maps be empty or absent? Empty
   implies "none"; absent implies "unknown".
