/**
 * Every map in a ROM, grouped for display.
 *
 *   Title Screen  $0C7
 *   New Game      $0C5
 *   bonus         $000, $100              entered after a level, not from a tile
 *                 ($0C8, $1C8 too when no map's wings block reaches them)
 *   overworld
 *   |- $105  entry map for a level
 *   |   |- $0C5  sub area
 *   |   |- $0C8  sub area, Yoshi Heaven, when this map or a sub area holds the wings block
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
import { reachableSlots } from './LevelTree'
import { findSpecialMaps, type SpecialMap, type SpecialRole } from './SpecialMaps'
import { findBonusEntrances, type BonusRole } from './BonusEntrances'
import { holdsWings, wingsColumns, wingsDestination } from './YoshiWings'
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
   * Always 'map' in this tree: a root's sub areas are a flat list, so nothing
   * nests, loops or truncates. 'loop' and 'truncated' are kept in the type
   * for the wire protocol.
   */
  kind: 'map' | 'loop' | 'truncated'
  /**
   * Set on a sub area the wings block links to this root (#1229), on that root's row only: it keeps Yoshi Heaven's
   * icon and tooltip, which a bonus row carries as its `role`.
   */
  reachedBy?: 'yoshi-heaven'
  /**
   * Other slots holding the identical Layer-1 bytes. Not copies: an edit here
   * is an edit to all of them, because a patch is written at the offset the
   * shared pointer resolves to. Empty for the common case. Carried on the node
   * so a view can warn before the user edits a map they are not looking at.
   * `CatalogEntry.spriteAliases` is the separate, and different, sprite-pointer
   * grouping.
   */
  l1Aliases: number[]
  /**
   * A New slot (D155): its Layer 1 pointer is zero or does not resolve to an
   * offset inside the ROM file, so there is no map data. Listed so every slot
   * appears (#901), never counted as a map, and no group takes it.
   */
  noPointer?: true
  /**
   * A map whose pointer is valid but whose data could not be read back. It stays
   * a map and its row warns; opening it gives the view's "could not be read" reply.
   */
  unreadable?: true
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
  /** Maps nothing reaches, the ones on the most common pointer included. */
  unassigned: number
  /** New slots: listed beside the unassigned maps but counted apart. */
  noPointer: number
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
  /** Slots the wings link placed under a root, so a groups.json that still names them is not stale. */
  wingsPlaced?: number[]
  /**
   * Maps no overworld root reaches, then the New slots, in slot order. Flat:
   * see the note in build.
   */
  unassigned: MapNode[]
  /**
   * Maps in the ROM: every slot with a usable pointer (docs/glossary.md: 512 on
   * vanilla). The tree lists mapCount + counts.noPointer slots.
   */
  mapCount: number
  counts: MapTreeCounts
  notes: string[]
}

/** Ids named in the unreadable-maps note before it says "and N more". */
const UNREADABLE_LISTED = 10

/**
 * Group every map in the ROM.
 *
 * Coverage is the contract: every real slot appears somewhere, either under
 * an overworld root or under unassigned. A root's sub areas are every
 * non-root slot reachable from it through the exit graph, listed once, flat
 * and in slot order (LevelTree.reachableSlots). A sub area reached from two
 * roots is listed under both.
 *
 * @param fingerprints Replaces the stock overworld fingerprints; for a synthetic ROM.
 */
export function buildMapTree(
  rom: SmwRom,
  fingerprints: OverworldFingerprints = STOCK_OVERWORLD_FINGERPRINTS,
): MapTree {
  const catalog = buildLevelCatalog(rom)
  // Listed but not a map: never a root or destination, as in the exit graph.
  // `maps` is the hierarchy's universe. Slots on the most common pointer are
  // maps too but stay out of it, and go straight to unassigned: they are never
  // roots, destinations or bonus targets, so the vanilla tree keeps its shape.
  const maps = new Set(catalog.entries.filter(e => e.isReal).map(e => e.index))
  const shared = catalog.entries.filter(e => e.sharedPointer).map(e => e.index)
  const noPointers = catalog.entries.filter(e => !e.pointed).map(e => e.index)
  /** Flags a slot whose pointer is valid but whose data ends in no marker, so the tree can warn instead of hiding it. */
  const unreadable = (index: number): { unreadable?: true } =>
    catalog.entries[index]!.pointed && !catalog.entries[index]!.terminated
      ? { unreadable: true }
      : {}
  const notes = [...catalog.notes]

  // Launch tiles the overworld grants a translevel, which is what a hacker
  // means by an entrance, and the source of the roots below. Traced in
  // OverworldEntrances; unreadable on a ROM whose overworld another editor
  // rebuilt, and reported as unknown.
  const entranceIndex = deriveOverworldEntrances(rom, catalog, fingerprints)
  /** Roots are the translevels the overworld grants, not every slot the ROM could list first. */
  const isRoot = (index: number): boolean => isOverworldLevel(index, entranceIndex.roots)

  const {
    graph: exitGraph,
    unavailable,
    unreadableMaps: graphCut,
    submapFlag: flags,
    screenHigh,
    secondaryExit,
  } = rom.buildLevelExitGraph(entranceIndex.roots, fingerprints.entry)

  /** The display name comes from the ROM's own tables; null when it has none, never a guess. */
  const name = (index: number): string | null => rom.getLevelName(index, entranceIndex)
  /** Other slots whose Layer 1 pointer is shared with this one, so the row can name its twins. */
  const aliasesOf = (index: number): number[] => catalog.entries[index]?.l1Aliases ?? []

  // Roots come from the map set, not from classifyLevels, so a slot the
  // latter deduped away still heads its own folder.
  const roots = [...maps].filter(isRoot).sort((a, b) => a - b)

  const placed = new Set<number>()
  /** Records the slot as placed so the Unassigned sweep later skips it, and builds its map node. */
  const adopt = (index: number, children: MapNode[] = []): MapNode => {
    placed.add(index)
    return {
      index,
      name: name(index),
      kind: 'map',
      l1Aliases: aliasesOf(index),
      ...unreadable(index),
      children,
    }
  }

  // Mirrors SmwRom.buildLevelExitGraph's `validDestinations` (no root, no
  // non-real slot); SmwRom.classify.test.ts pins that invariant, so neither
  // half is observable here.
  const stops = (i: number): boolean => isRoot(i) || !maps.has(i)
  const bonusRead = findBonusEntrances(rom.rom, fingerprints.bonus)

  const subsOf = new Map(roots.map(r => [r, reachableSlots(r, exitGraph, stops)]))

  // Yoshi Heaven joins the root whose own maps hold the wings block (#1229). The game files the
  // destination as (OWPlayerSubmap high byte, DATA_05DBA9 low byte) exactly as a screen exit does,
  // so the half is the root's propagated flag, never the wings map's own slot half. Yoshi Heaven's
  // own exits are not followed (the walk never reaches it): maps only it reaches stay Unassigned.
  const yoshiLow = bonusRead.maps.find(m => m.role === 'yoshi-heaven')?.index
  const wingsDest = new Map<number, number>()
  const yoshiStays = 'Yoshi Heaven stays listed as a bonus map.'
  if (flags && yoshiLow !== undefined) {
    try {
      const cols = wingsColumns(rom.rom, fingerprints.wings)
      if (!('columns' in cols)) notes.push(`Yoshi wings: ${cols.note} ${yoshiStays}`)
      else {
        // A holder whose exits are not known to be primary is not counted: a secondary exit sends the
        // trip through DATA_05F800 (bank_05.asm:7111-7117), and an unreadable stream hides its exits.
        const secondary = new Set<number>()
        const unread = new Set<number>()
        const refusedDests = new Set<number>()
        for (const [root, subs] of subsOf) {
          const holders = [root, ...subs].filter(i => holdsWings(rom, i, cols.columns, fingerprints.wings)) // prettier-ignore
          const dest = wingsDestination(!!flags.get(root), screenHigh!, yoshiLow)
          holders.filter(i => secondaryExit?.has(i)).forEach(i => secondary.add(i))
          holders.filter(i => graphCut?.includes(i)).forEach(i => unread.add(i))
          const ok = holders.filter(i => !secondaryExit?.has(i) && !graphCut?.includes(i))
          if (ok.length && !stops(dest)) wingsDest.set(root, dest)
          else if (holders.length) refusedDests.add(dest)
        }
        const placedNow = new Set(wingsDest.values())
        const stays = [...refusedDests].some(d => !placedNow.has(d)) ? ` ${yoshiStays}` : '' // prettier-ignore
        const ids = (set: Set<number>): string => [...set].map(i => '$' + i.toString(16).toUpperCase().padStart(3, '0')).join(', ') // prettier-ignore
        const say = (set: Set<number>, why: string): void => {
          if (set.size)
            notes.push(`Yoshi wings: ${ids(set)} ${set.size === 1 ? 'holds the wings block but has' : 'hold the wings block but have'} ${why}, so ${set.size === 1 ? 'it is' : 'they are'} not linked.${stays}`) // prettier-ignore
        }
        say(
          secondary,
          'a secondary screen exit, which the game sends through a table that is not read',
        )
        say(unread, 'object data that could not be read to its end, so its exits are unknown')
      }
    } catch (err) {
      wingsDest.clear()
      notes.push(`Yoshi wings: could not be read (${err instanceof Error ? err.message : String(err)}). ${yoshiStays}`) // prettier-ignore
    }
  }
  const wingsPlaced = new Set(wingsDest.values())
  const overworld = roots.map(root => {
    const subs = subsOf.get(root)!
    const dest = wingsDest.get(root)
    const kids = dest === undefined || subs.includes(dest) ? subs : [...subs, dest].sort((a, b) => a - b) // prettier-ignore
    const children = kids.map(i => {
      const node = adopt(i)
      if (i === dest) node.reachedBy = 'yoshi-heaven'
      return node
    })
    return adopt(root, children)
  })

  // Read from the ROM, and only adopted when the slot named is in the hierarchy's
  // map set. A repointed routine could name a New slot or one on the most common
  // pointer; both are listed in Unassigned already, so adopting one would list it twice.
  const found = findSpecialMaps(rom.rom)
  notes.push(...found.notes, ...bonusRead.notes)
  // One pass, so a slot named twice (by two roles, on a hack) is placed once.
  const adoptHits = <R extends string>(hits: SpecialMap<R>[]): SpecialMapNode<R>[] =>
    hits.flatMap(hit => {
      if (!maps.has(hit.index) || placed.has(hit.index)) return []
      placed.add(hit.index)
      const { index } = hit
      return [
        {
          ...hit,
          name: name(index),
          kind: 'map' as const,
          l1Aliases: aliasesOf(index),
          ...unreadable(index),
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
  const realUnassignedIds = [...maps].filter(i => !placed.has(i))
  const realUnassigned = realUnassignedIds.length
  const unassigned: MapNode[] = [...realUnassignedIds, ...shared, ...noPointers]
    .sort((a, b) => a - b)
    .map(i => ({
      index: i,
      name: name(i),
      kind: 'map' as const,
      l1Aliases: aliasesOf(i),
      ...(catalog.entries[i]!.pointed ? unreadable(i) : { noPointer: true as const }),
      children: [],
    }))
  const unassignedMaps = realUnassigned + shared.length
  const mapCount = maps.size + shared.length

  if (unavailable) {
    notes.push(
      `Map hierarchy unavailable: ${unavailable} Sub areas are listed unassigned rather ` +
        'than grouped by a rule this ROM may not follow. Every map is still listed and editable.',
    )
  } else if (unassignedMaps > 0) {
    notes.push(
      `${unassignedMaps} of ${mapCount} maps are unassigned: no overworld root ` +
        'reaches them through the exit graph. They are listed flat because an ' +
        "orphan's own screen exits are left unresolved by design (SmwRom.buildLevelExitGraph).",
    )
  }

  // Every map the rows warn on, shared-pointer ones included, so the note and the rows agree.
  const unreadableMaps = catalog.entries.filter(e => e.pointed && !e.terminated).map(e => e.index)
  if (unreadableMaps.length) {
    const n = unreadableMaps.length
    const ids = unreadableMaps
      .slice(0, UNREADABLE_LISTED)
      .map(i => `$${i.toString(16).toUpperCase().padStart(3, '0')}`)
    const more = n > UNREADABLE_LISTED ? ` and ${n - UNREADABLE_LISTED} more` : ''
    notes.push(
      `${n} ${n === 1 ? 'map has' : 'maps have'} object data that could not be read to its end, so screen exits from ${n === 1 ? 'it' : 'them'} may be missing: ${ids.join(', ')}${more}.`,
    )
  }

  // The graph reads less of a stream than the rows do, so it can lose a map's exits with no row warning.
  const listed = (ids: number[]): string =>
    ids
      .slice(0, UNREADABLE_LISTED)
      .map(i => `$${i.toString(16).toUpperCase().padStart(3, '0')}`)
      .join(', ') +
    (ids.length > UNREADABLE_LISTED ? ` and ${ids.length - UNREADABLE_LISTED} more` : '')
  if (graphCut?.length) {
    const n = graphCut.length
    notes.push(
      `${n} ${n === 1 ? 'map has' : 'maps have'} more connections than could be read, so ${n === 1 ? 'it' : 'they'} may lead to maps this tree lists as unreached: ${listed(graphCut)}.`,
    )
  }

  if (!entranceIndex.overworldReadable) notes.push(...entranceIndex.notes)

  const counts: MapTreeCounts = {
    entrances: entranceIndex.overworldReadable ? entranceIndex.entrances.length : null,
    unassigned: unassignedMaps,
    noPointer: noPointers.length,
  }

  return {
    special,
    bonus,
    overworld,
    wingsPlaced: [...wingsPlaced],
    unassigned,
    mapCount,
    counts,
    notes,
  }
}
