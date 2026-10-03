/**
 * Every map in a ROM, grouped for display.
 *
 *   Title Screen  $0C7
 *   New Game      $0C5
 *   bonus         $000, $100, $0C8, $1C8  entered after a level, not from a tile
 *   overworld
 *   |- $105  entry map for a level
 *   |   |- $0C5  sub area
 *   |   \- $0C6  sub area
 *   \- $106
 *       \- $1C9
 *   unassigned
 *   \- $0D3  real map no overworld root reaches
 *
 * Terms are the glossary's (docs/glossary.md): a MAP is a slot holding real
 * data and is the editable unit, a SUB AREA is a map reachable only from
 * another map, and a map nothing reaches is ORPHANED.
 *
 * The enumeration comes from buildLevelCatalog, never from
 * SmwRom.classifyLevels, for two measured reasons on the vanilla cart:
 *
 *  - classifyLevels reports $012 as an overworld level although its L1
 *    pointer is the filler, because it gates on levelHasObjects() and the
 *    filler room holds well-formed object data (SmwRom.ts,
 *    _findFillerL1Pointer). The catalog decides by pointer identity and
 *    excludes it.
 *  - classifyLevels dedupes by L1 pointer, which hides 42 real slots that
 *    share a pointer with an earlier slot. They are maps and the user owns
 *    them.
 *
 * The exit graph is used only to GROUP maps, never to decide which exist, so
 * a ROM whose exit graph degrades loses hierarchy and not maps.
 */
import { SmwRom, isOverworldLevel } from './SmwRom'
import { buildLevelCatalog } from './LevelCatalog'
import { buildLevelSubtree, LevelTreeNode } from './LevelTree'
import { findSpecialMaps, type SpecialMap, type SpecialRole } from './SpecialMaps'
import { findBonusEntrances, type BonusRole } from './BonusEntrances'
import {
  deriveOverworldEntrances,
  STOCK_OVERWORLD_FINGERPRINTS,
  type OverworldFingerprints,
} from './OverworldEntrances'

export interface MapNode {
  /** Pointer-table slot, $000-$1FF. */
  index: number
  /**
   * Decoded from the ROM's own name tables, so an edited cart reads back its
   * own names. Null for slots the name tables do not cover, which is most
   * sub-areas.
   */
  name: string | null
  /**
   * 'map' expands. 'loop' is a back edge to a map already on the path from
   * this root, and 'truncated' is a subtree that hit LevelTree's caps;
   * neither expands, and both are shown rather than dropped so nothing
   * disappears silently.
   */
  kind: 'map' | 'loop' | 'truncated'
  /**
   * Other slots holding the identical Layer-1 bytes. Not copies: an edit here
   * is an edit to all of them, because a patch is written at the offset the
   * shared pointer resolves to. Empty for the common case. Carried on the node
   * so a view can warn before the user edits a map they are not looking at.
   * `CatalogEntry.spriteAliases` is the separate, and different, sprite-pointer
   * grouping.
   */
  l1Aliases: number[]
  children: MapNode[]
}

/**
 * A map the game enters without the overworld, named by what it is for. With
 * a BonusRole it is one entered after a level: reached, so never orphaned,
 * but not an entry map either.
 */
export interface SpecialMapNode<R extends string = SpecialRole> extends MapNode {
  role: R
  /** The SNES address the slot was read from, for a citation the user can check. */
  foundAt: string
}

/**
 * Counts the explorer shows beside a group label.
 *
 * `entrances` is null when the overworld is not readable, which
 * deriveOverworldEntrances reports for a ROM another editor rebuilt. Null
 * means unknown, not zero, and the label must not show a number for it.
 */
export interface MapTreeCounts {
  entrances: number | null
  unassigned: number
}

export interface MapTree {
  /**
   * The title screen and the new-game intro, in the order a player meets
   * them. Either may be absent: on a ROM whose loader has been replaced the
   * slot cannot be read, and the map stays among the unassigned rather than
   * being guessed at.
   */
  special: SpecialMapNode[]
  /** Top-level like `overworld`, and absent the same way `special` is. */
  bonus: SpecialMapNode<BonusRole>[]
  /** Maps the overworld can start, each with its sub-areas beneath it. */
  overworld: MapNode[]
  /** Real maps no overworld root reaches. Flat: see the note in build. */
  unassigned: MapNode[]
  /** Real maps in the ROM. The tree is required to cover exactly this many. */
  mapCount: number
  counts: MapTreeCounts
  notes: string[]
}

/**
 * Group every map in the ROM.
 *
 * A map is every real slot sharing one L1 pointer (#434), labelled by its
 * lowest overworld-entrance slot, else its lowest slot. Coverage is the
 * contract: every map appears somewhere, either under an overworld root or
 * under unassigned; `mapCount` counts maps, not slots. A sub-area reached from two levels
 * is expanded under both, matching how a player navigates rather than the
 * graph's node set (see LevelTree.buildLevelSubtree), so deeper duplicates
 * are intended; only the top level of each root is unique.
 *
 * @param fingerprints Replaces the stock overworld fingerprints; for a synthetic ROM.
 */
export function buildMapTree(
  rom: SmwRom,
  fingerprints: OverworldFingerprints = STOCK_OVERWORLD_FINGERPRINTS,
): MapTree {
  const catalog = buildLevelCatalog(rom)
  const notes = [...catalog.notes]

  // Launch tiles the overworld grants a translevel, which is what a hacker
  // means by an entrance, and the source of the roots below. Traced in
  // OverworldEntrances; unreadable on a ROM whose overworld another editor
  // rebuilt, and reported as unknown.
  const entranceIndex = deriveOverworldEntrances(rom, catalog, fingerprints)
  const isRoot = (index: number): boolean => isOverworldLevel(index, entranceIndex.roots)

  const { graph: exitGraph, unavailable } = rom.buildLevelExitGraph(
    entranceIndex.roots,
    fingerprints.entry,
  )

  const name = (index: number): string | null => rom.getLevelName(index, entranceIndex)
  const aliasesOf = (index: number): number[] => catalog.entries[index]?.l1Aliases ?? []

  // A MAP is the set of real slots sharing one L1 pointer (the catalog's
  // l1Aliases), on both sides of $100. It is labelled by its lowest
  // overworld-entrance slot, else its lowest slot. The exit graph stays
  // slot-based (each slot's destination high byte needs its own submap flag).
  const mapOf = new Map<number, number>()
  for (const e of catalog.entries) {
    if (!e.isReal || mapOf.has(e.index)) continue
    const members = [e.index, ...e.l1Aliases].sort((a, b) => a - b)
    const label = members.find(isRoot) ?? members[0]!
    for (const m of members) mapOf.set(m, label)
  }
  const maps = new Set(mapOf.values())

  // Map -> map edges: the union over a map's slots of their resolved exits.
  // Only slots the BFS reached have edges. Which exit leads to which entrance
  // is dropped here (#444); a destination outside the map set is filler the
  // exit data still points at, and self edges add nothing.
  const mapGraph = new Map<number, number[]>()
  for (const [slot, dests] of exitGraph) {
    const from = mapOf.get(slot)
    if (from === undefined) continue
    const out = mapGraph.get(from) ?? []
    for (const d of dests) {
      const to = mapOf.get(d)
      if (to !== undefined && to !== from && !out.includes(to)) out.push(to)
    }
    mapGraph.set(from, out)
  }

  // Roots come from the map set, not from classifyLevels, so a slot the
  // latter deduped away still heads its own folder.
  const roots = [...maps].filter(isRoot).sort((a, b) => a - b)

  const placed = new Set<number>()
  const adopt = (node: LevelTreeNode): MapNode => {
    placed.add(node.index)
    return {
      index: node.index,
      name: name(node.index),
      // LevelTree says 'room' for an expandable node; the glossary's term for
      // the editable unit is 'map', and this module speaks the glossary.
      kind: node.kind === 'room' ? 'map' : node.kind,
      l1Aliases: aliasesOf(node.index),
      children: node.children.map(adopt),
    }
  }

  // Another root map heads its own folder, but the current root is a loop target.
  const overworld = roots.map(root =>
    adopt(buildLevelSubtree(root, mapGraph, m => isRoot(m) && m !== root)),
  )

  // Read from the ROM, and only adopted when the slot named actually holds a
  // real map: a routine that has been repointed could name a filler slot,
  // and listing that would invent a map.
  const found = findSpecialMaps(rom.rom)
  const bonusRead = findBonusEntrances(rom.rom, fingerprints.bonus)
  notes.push(...found.notes, ...bonusRead.notes)
  const treeMaps = new Set(placed)
  const hitSlots = new Set<number>()
  // One pass, so a slot named twice (by two roles, on a hack) is placed once.
  const adoptHits = <R extends string>(hits: SpecialMap<R>[]): SpecialMapNode<R>[] =>
    hits.flatMap(hit => {
      const map = mapOf.get(hit.index)
      // Two roles can name slots of one map ($000 and $100 on vanilla); both are
      // listed, because the role is what the user reads. A map the overworld
      // tree already holds is not listed again.
      if (map === undefined || treeMaps.has(map) || hitSlots.has(hit.index)) return []
      hitSlots.add(hit.index)
      placed.add(map)
      const { index } = hit
      return [
        {
          ...hit,
          name: name(index),
          kind: 'map' as const,
          l1Aliases: aliasesOf(index),
          children: [],
        },
      ]
    })
  // Construction order is play order: title, intro, then what follows a level.
  const special = adoptHits(found.maps)
  const bonus = adoptHits(bonusRead.maps)

  // Flat by construction, not by omission. SmwRom.buildLevelExitGraph
  // resolves a map's exits only once its BFS reaches it from an overworld
  // root, because the destination high byte comes from the root's submap
  // flag; an orphan is never reached, so it contributes no edges and its own
  // sub-areas cannot be grouped under it. That is the fail-closed behaviour
  // SmwRom documents, and inferring a flag here would be a ROM-behaviour
  // claim this module is not the place to make. Tracked separately. When the
  // graph is unavailable every non-root map lands here, which is still
  // complete coverage.
  const unassigned = [...maps]
    .filter(i => !placed.has(i))
    .sort((a, b) => a - b)
    .map(i => ({
      index: i,
      name: name(i),
      kind: 'map' as const,
      l1Aliases: aliasesOf(i),
      children: [],
    }))

  if (unavailable) {
    notes.push(
      `Map hierarchy unavailable: ${unavailable} Sub areas are listed unassigned rather ` +
        'than grouped by a rule this ROM may not follow. Every map is still listed and editable.',
    )
  } else if (unassigned.length > 0) {
    notes.push(
      `${unassigned.length} of ${maps.size} maps are unassigned: no overworld root ` +
        'reaches them through the exit graph. They are listed flat because an ' +
        "orphan's own exits are left unresolved by design (SmwRom.buildLevelExitGraph).",
    )
  }

  if (!entranceIndex.overworldReadable) notes.push(...entranceIndex.notes)

  const counts: MapTreeCounts = {
    entrances: entranceIndex.overworldReadable ? entranceIndex.entrances.length : null,
    unassigned: unassigned.length,
  }

  return { special, bonus, overworld, unassigned, mapCount: maps.size, counts, notes }
}
