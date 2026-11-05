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

import { SmwRom, LEVEL_COUNT, findCommonPointer } from './SmwRom'

/** One of the 512 level pointer-table slots. */
export interface CatalogEntry {
  index: number
  l1Pointer: number
  /**
   * True when the slot is pointed and not on the most common pointer: the set
   * the exit graph and the tree's hierarchy are built from. Slots on the common
   * pointer are maps too (`pointed`) but never roots or destinations.
   */
  isReal: boolean
  /** True on the pointer findCommonPointer names (on vanilla, 277 slots at $068000). */
  sharedPointer: boolean
  /**
   * True when the slot is a map: its pointer is not zero and resolves to an
   * offset inside the ROM file (D155). False is a New slot, one with nothing
   * to open. Whether the data parses is `parseable`, a different question.
   */
  pointed: boolean
  /** True when a pointed slot's level data could actually be read back. */
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
  /** The most common pointer, or 0 when none repeats enough. */
  fillerPointer: number
  /** Slots sharing the most common pointer; 0 when the ROM has none. */
  sharedPointerCount: number
  /** Slots that are `isReal`. */
  realCount: number
  /** Of the `isReal` slots, how many parse. Slots on the common pointer are not counted. */
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
 * The most common pointer is a statistical call, so say so when the roles may
 * be swapped: a runner-up over half as common, or a pointer under a tenth of
 * the slots. Neither fires on the corpus (common 158-277, runner-up <= 8).
 */
const MIN_COMMON_SHARE = 0.1
const MIN_COMMON_MARGIN_RATIO = 2

/**
 * Builds the level catalog. A slot is pointed (a map) when its pointer is not
 * zero and resolves inside the ROM file. It is real when it is also not on the
 * most common pointer -- decided by pointer identity alone,
 * never via levelHasObjects(), which cannot spot filler (the filler room holds
 * well-formed objects), so this catalog does not need it. A
 * real slot is parseable when SmwRom.getLevelRawData can read it back at
 * all, which needs only the five header bytes before the ROM ends: editors
 * can place a level in the ROM's last bytes. Unparseable real slots are the
 * observable symptom of the expanded-ROM addressing gap on the two 4 MB ROMs
 * in the corpus, out of scope to fix here.
 */
export function buildLevelCatalog(rom: SmwRom): LevelCatalog {
  const pointers = Array.from({ length: LEVEL_COUNT }, (_, i) => rom.getLevelL1Pointer(i) ?? 0)
  const common = findCommonPointer(pointers)

  const entries: CatalogEntry[] = []
  const notes: string[] = []
  let realCount = 0
  let parseableCount = 0
  let unreadableRealCount = 0

  for (let i = 0; i < LEVEL_COUNT; i++) {
    const l1Pointer = pointers[i]!
    const pointed = l1Pointer !== 0 && rom.rom.fileOffsetOf(l1Pointer) !== null
    const sharedPointer = pointed && common !== null && l1Pointer === common.pointer
    const isReal = pointed && !sharedPointer
    const parseable = pointed && rom.getLevelRawData(i) !== null

    if (isReal) {
      realCount++
      if (parseable) parseableCount++
      else unreadableRealCount++
    }
    entries.push({
      index: i,
      l1Pointer,
      isReal,
      sharedPointer,
      pointed,
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

  if (common) {
    const shareLow = common.count / LEVEL_COUNT < MIN_COMMON_SHARE
    const marginThin = common.count < MIN_COMMON_MARGIN_RATIO * common.runnerUpCount
    if (shareLow || marginThin) {
      notes.push(
        `Most-common-pointer confidence low: 0x${common.pointer.toString(16).padStart(6, '0')} ` +
          `appears ${common.count}/${LEVEL_COUNT} times, runner-up appears ${common.runnerUpCount} ` +
          'times. isReal/parseable below may not reflect the true hierarchy slots. ' +
          'See docs/ideas/level-classification.md, Tier 1.',
      )
    }
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
    fillerPointer: common?.pointer ?? 0,
    sharedPointerCount: common?.count ?? 0,
    realCount,
    parseableCount,
    aliasedSlotCount,
    l1AliasGroupCount,
    notes,
  }
}
