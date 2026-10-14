/**
 * LevelCatalog.ts -- Tier 1 of the level catalog design
 * (docs/ideas/level-classification.md). Enumerates the 512 L1 pointer-table
 * slots and reports which hold real level data, independent of the
 * overworld or exit graph. Tier 1 here is intended to eventually replace
 * SmwRom.classifyLevels, once Tier 2/3 grouping (Maps, Sub-areas) is built on
 * top of it; classifyLevels and its callers are untouched by this change.
 *
 * Kept in its own file rather than folded into SmwRom.ts: SmwRom.ts is
 * already ~450 lines, and LevelTree.ts sets the precedent of a pure,
 * SmwRom-independent function living in its own file instead of growing
 * SmwRom.ts further.
 *
 * This module never touches the pointer table directly -- it reads slots
 * through SmwRom.getLevelL1Pointer(); see that accessor for the table's
 * layout and ASM citation.
 */

import { SmwRom, LEVEL_COUNT, findPlaceholderPointer } from './SmwRom'

/** One of the 512 level pointer-table slots. */
export interface CatalogEntry {
  index: number
  l1Pointer: number
  /** True when the slot has a pointer and it is not the shared placeholder room. */
  isReal: boolean
  /**
   * True when l1Pointer is the shared placeholder room, the one pointer
   * findPlaceholderPointer names (SmwRom's exit graph asks the same helper).
   * Exactly the pointered slots that are not real.
   */
  placeholder: boolean
  /** True when the slot's level data could actually be read back. */
  parseable: boolean
  /**
   * Other real slots whose L1 pointer is identical to this one, ascending.
   *
   * These are not copies, they are the same bytes. An edit is a byte patch at
   * a file offset derived from the pointer, so editing Layer-1 data "for this
   * slot" edits every slot listed here as well. Vanilla shares 63 of its 235
   * real slots across 21 groups, so this is the normal case, not an oddity.
   *
   * Filler slots always report [] : 277 of them share the filler pointer, and
   * calling that 276 aliases each would be true, useless, and would bury the
   * real groups.
   */
  l1Aliases: number[]
  /**
   * The same, for the sprite pointer. Tracked separately because sharing is
   * per data stream: on vanilla, $0EB's six slots share one L1 pointer but two
   * different sprite pointers, so an object move and a sprite delete affect
   * different sets. One combined "is aliased" flag would be wrong for both.
   */
  spriteAliases: number[]
}

export interface LevelCatalog {
  entries: CatalogEntry[]
  /** The placeholder pointer (SmwRom.findPlaceholderPointer), or 0 when no pointer repeats enough. */
  fillerPointer: number
  /** Slots sharing the placeholder room, read from the pointer table; 0 when the ROM has none. */
  placeholderCount: number
  realCount: number
  parseableCount: number
  /**
   * Real slots sharing Layer-1 data with at least one other real slot, and the
   * number of distinct groups they form. Reported as data, not in `notes`:
   * `notes` carries correctness caveats about the catalog itself, and aliasing
   * is a property of the cart that is true of a perfectly-read ROM.
   */
  aliasedSlotCount: number
  l1AliasGroupCount: number
  notes: string[]
}

/**
 * The placeholder pointer is only a statistical call: nothing here can tell it
 * from a real sublevel reused often. When the runner-up is more than half as
 * common, the roles may be swapped, so say so rather than invert silently.
 * Measured corpus margins are comfortable (placeholder 158-277 slots, largest
 * runner-up 8), so this never fires on a real ROM.
 */
const MIN_PLACEHOLDER_MARGIN_RATIO = 2

/**
 * Builds the level catalog. A slot is real when it has a pointer and that
 * pointer is not the shared placeholder -- decided by pointer identity alone, never via
 * levelHasObjects(), which cannot spot filler (the filler room holds
 * well-formed objects), so this catalog does not need it. A
 * real slot is parseable when SmwRom.getLevelRawData can read it back at
 * all, which needs only the five header bytes before the ROM ends: editors
 * can place a level in the ROM's last bytes. Unparseable real slots are the
 * observable symptom of the expanded-ROM addressing gap on the two 4 MB ROMs
 * in the corpus, out of scope to fix here.
 */
export function buildLevelCatalog(rom: SmwRom): LevelCatalog {
  const pointers = Array.from({ length: LEVEL_COUNT }, (_, i) => rom.getLevelL1Pointer(i) ?? 0)
  const placeholder = findPlaceholderPointer(pointers)

  const entries: CatalogEntry[] = []
  const notes: string[] = []
  let realCount = 0
  let parseableCount = 0
  let unreadableRealCount = 0

  for (let i = 0; i < LEVEL_COUNT; i++) {
    const l1Pointer = pointers[i]!
    const isReal = l1Pointer !== 0 && l1Pointer !== placeholder?.pointer
    let parseable = false

    if (isReal) {
      const data = rom.getLevelRawData(i)
      parseable = data !== null
      if (!parseable) unreadableRealCount++
      realCount++
    }

    if (parseable) parseableCount++
    entries.push({
      index: i,
      l1Pointer,
      isReal,
      placeholder: placeholder !== null && l1Pointer === placeholder.pointer,
      parseable,
      l1Aliases: [],
      spriteAliases: [],
    })
  }

  // Alias groups, over real slots only. Two passes rather than one: the groups
  // cannot be known until every pointer has been seen.
  const groupBy = (ptrOf: (index: number) => number | null) => {
    const byPointer = new Map<number, number[]>()
    for (const e of entries) {
      if (!e.isReal) continue
      const ptr = ptrOf(e.index)
      if (ptr === null) continue
      const bucket = byPointer.get(ptr)
      if (bucket) bucket.push(e.index)
      else byPointer.set(ptr, [e.index])
    }
    return byPointer
  }

  const l1Groups = groupBy(i => pointers[i] ?? null)
  const spriteGroups = groupBy(i => rom.getLevelSpritePointer(i))

  for (const [, members] of l1Groups) {
    if (members.length < 2) continue
    for (const index of members) {
      entries[index]!.l1Aliases = members.filter(m => m !== index)
    }
  }
  for (const [, members] of spriteGroups) {
    if (members.length < 2) continue
    for (const index of members) {
      entries[index]!.spriteAliases = members.filter(m => m !== index)
    }
  }

  const l1AliasGroupCount = [...l1Groups.values()].filter(m => m.length > 1).length
  const aliasedSlotCount = entries.filter(e => e.l1Aliases.length > 0).length

  if (placeholder && placeholder.count < MIN_PLACEHOLDER_MARGIN_RATIO * placeholder.runnerUpCount) {
    notes.push(
      `Placeholder-pointer confidence low: 0x${placeholder.pointer.toString(16).padStart(6, '0')} ` +
        `appears ${placeholder.count}/${LEVEL_COUNT} times, runner-up appears ${placeholder.runnerUpCount} ` +
        'times. isReal/parseable below may not reflect true placeholder vs. real slots -- see ' +
        'docs/ideas/level-classification.md Tier 1.',
    )
  }
  if (unreadableRealCount > 0) {
    notes.push(
      `${unreadableRealCount} of ${realCount} real slots did not parse (level data ` +
        'unreadable at its pointer). Likely expanded-ROM bank addressing on ROMs larger ' +
        'than 512 KB -- see docs/ideas/level-classification.md Tier 1. Out of scope here.',
    )
  }

  return {
    entries,
    fillerPointer: placeholder?.pointer ?? 0,
    placeholderCount: placeholder?.count ?? 0,
    realCount,
    parseableCount,
    aliasedSlotCount,
    l1AliasGroupCount,
    notes,
  }
}
