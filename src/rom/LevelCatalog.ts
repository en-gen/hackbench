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

import { SmwRom, LEVEL_COUNT } from './SmwRom'

/** One of the 512 level pointer-table slots. */
export interface CatalogEntry {
  index: number
  l1Pointer: number
  /** True when l1Pointer is not the per-ROM filler value. */
  isReal: boolean
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
  /** Most frequent L1 pointer across all 512 slots -- this ROM's filler value. */
  fillerPointer: number
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

interface FillerAnalysis {
  pointer: number
  count: number
  runnerUpCount: number
}

/**
 * The mode heuristic can only report a *statistical* filler, not a verified
 * one: nothing here can tell a true filler apart from a real sublevel that
 * happens to be reused often. These thresholds gate how much to trust that
 * mode before treating isReal/parseable as meaningful. Measured corpus
 * margins are comfortable (mode counts hold 150-269 of the 512 slots, with
 * the largest runner-up seen at just 8), so neither threshold fires on real
 * ROMs; they exist for the ROMs that would silently invert without them.
 */
const MIN_FILLER_SHARE = 0.1
const MIN_FILLER_MARGIN_RATIO = 2

/**
 * The filler L1 pointer padding unused slots, found empirically as the mode
 * of all 512 entries -- never hardcoded. It is $068000 on vanilla but must
 * not be assumed to hold elsewhere; see docs/ideas/level-classification.md.
 * Also reports the mode's count and the runner-up's count so the caller can
 * judge confidence -- see MIN_FILLER_SHARE / MIN_FILLER_MARGIN_RATIO.
 */
function findFillerPointer(pointers: readonly number[]): FillerAnalysis {
  const counts = new Map<number, number>()
  for (const ptr of pointers) counts.set(ptr, (counts.get(ptr) ?? 0) + 1)

  let pointer = pointers[0] ?? 0
  let count = 0
  let runnerUpCount = 0
  for (const [ptr, c] of counts) {
    if (c > count) {
      runnerUpCount = count
      count = c
      pointer = ptr
    } else if (c > runnerUpCount) {
      runnerUpCount = c
    }
  }
  return { pointer, count, runnerUpCount }
}

/**
 * Builds the level catalog. A slot is real when its L1 pointer differs from
 * the computed filler value -- decided by pointer identity alone, never via
 * levelHasObjects(), which has its own documented, unrelated defect (see
 * SmwRom.ts) that this catalog does not need and does not route around. A
 * real slot is parseable when SmwRom.getLevelRawData can read it back at
 * all; the measured minimum size on every parseable slot across the six-ROM
 * corpus is 0x2000 bytes, so "readable at all" is the only threshold that
 * means anything here. Unparseable real slots are the observable symptom of
 * the expanded-ROM addressing gap on the two 4 MB ROMs in the corpus, out of
 * scope to fix here.
 */
export function buildLevelCatalog(rom: SmwRom): LevelCatalog {
  const pointers = Array.from({ length: LEVEL_COUNT }, (_, i) => rom.getLevelL1Pointer(i) ?? 0)
  const filler = findFillerPointer(pointers)

  const entries: CatalogEntry[] = []
  const notes: string[] = []
  let realCount = 0
  let parseableCount = 0
  let unreadableRealCount = 0

  for (let i = 0; i < LEVEL_COUNT; i++) {
    const l1Pointer = pointers[i]!
    const isReal = l1Pointer !== filler.pointer
    let parseable = false

    if (isReal) {
      const data = rom.getLevelRawData(i)
      parseable = data !== null
      if (!parseable) unreadableRealCount++
      realCount++
    }

    if (parseable) parseableCount++
    entries.push({ index: i, l1Pointer, isReal, parseable, l1Aliases: [], spriteAliases: [] })
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

  const shareLow = filler.count / LEVEL_COUNT < MIN_FILLER_SHARE
  const marginThin = filler.count < MIN_FILLER_MARGIN_RATIO * filler.runnerUpCount
  if (shareLow || marginThin) {
    notes.push(
      `Filler-pointer confidence low: mode 0x${filler.pointer.toString(16).padStart(6, '0')} ` +
        `appears ${filler.count}/${LEVEL_COUNT} times, runner-up appears ${filler.runnerUpCount} ` +
        'times. isReal/parseable below may not reflect true filler vs. real slots -- see ' +
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
    fillerPointer: filler.pointer,
    realCount,
    parseableCount,
    aliasedSlotCount,
    l1AliasGroupCount,
    notes,
  }
}
