import { describe, it, expect, vi } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR, LEVEL_COUNT, findCommonPointer } from '../../../src/rom/SmwRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import {
  assertCatalogAcceptance,
  assertVariantNames,
  buildBrokenCatalogVariants,
} from '../support/catalogAcceptance'

// Size chosen so (size % 1024) !== 512, so RomFile never treats this as
// copier-headered -- keeps pointer math free of the +512 header offset.
const BUF_SIZE = 0x40000
const L1_TABLE_OFFSET = loromToOffset(ADDR.LEVEL_L1_PTR, BUF_SIZE)!

/** Builds a synthetic LoROM image with a hand-picked L1 pointer per slot. */
function buildFakeRom(
  pointerOf: (index: number) => number,
  readable: Set<number> = new Set(),
): SmwRom {
  const buf = Buffer.alloc(BUF_SIZE, 0)
  buf[0x7fd5] = 0x20 // LoROM map-mode byte -- required by SmwRom's constructor check
  for (let i = 0; i < LEVEL_COUNT; i++) {
    const ptr = pointerOf(i)
    const base = L1_TABLE_OFFSET + i * 3
    buf[base] = ptr & 0xff
    buf[base + 1] = (ptr >> 8) & 0xff
    buf[base + 2] = (ptr >> 16) & 0xff
    if (readable.has(ptr)) {
      const off = loromToOffset(ptr, BUF_SIZE)
      if (off !== null) buf[off + 5] = 0xff // 5-byte header + immediate terminator
    }
  }
  return new SmwRom(new RomFile('fake.sfc', buf))
}

const FILLER = 0x018000
const RUNNER_UP = 0x028000 // one slot short of FILLER -- not a wide margin

describe('buildLevelCatalog (synthetic)', () => {
  it('picks the most frequent pointer as filler, even by a margin of one', () => {
    // 100 filler slots, 99 runner-up slots, the rest unique real pointers.
    const rom = buildFakeRom(i => {
      if (i < 100) return FILLER
      if (i < 199) return RUNNER_UP
      return 0x038000 + i // unique per remaining slot
    })
    const catalog = buildLevelCatalog(rom)
    expect(catalog.fillerPointer).toBe(FILLER)
    expect(catalog.entries.slice(0, 100).every(e => !e.isReal)).toBe(true)
    expect(catalog.entries.slice(100, 199).every(e => e.isReal)).toBe(true)
    expect(catalog.realCount).toBe(LEVEL_COUNT - 100)
  })

  it('marks readable real slots parseable and unreadable ones not', () => {
    const READABLE = 0x048000
    // Resolves to the buffer's last two bytes: a valid pointer with no room for a header.
    const UNREADABLE = 0x07fffe
    const rom = buildFakeRom(
      i => (i === 0 ? READABLE : i === 1 ? UNREADABLE : FILLER),
      new Set([READABLE]),
    )
    const catalog = buildLevelCatalog(rom)
    expect(catalog.entries[0]).toMatchObject({ isReal: true, pointed: true, parseable: true })
    expect(catalog.entries[1]).toMatchObject({ isReal: true, pointed: true, parseable: false })
    expect(catalog.parseableCount).toBe(1)
    // realCount - parseableCount is the machine-readable gap; a note exists
    // to surface it in a UI, but tests assert on the counts, not its wording.
    expect(catalog.realCount - catalog.parseableCount).toBe(1)
    expect(catalog.notes.length).toBeGreaterThan(0)
  })

  // D155: zero or a pointer outside the ROM file is New (not pointed); a pointer that
  // resolves stays a map even when its data cannot be read. Swept over both sides of the end.
  it.each([
    [0, false],
    [0x3f8000, false], // bank 7F: past the end of this 256 KB buffer
    [0x7e8000, false], // WRAM
    [0x001234, false], // registers / low RAM
    [0x07fffe, true], // last two bytes of the buffer
    [0x048000, true],
  ])('a slot at pointer $%s is pointed: %s', (ptr, pointed) => {
    const catalog = buildLevelCatalog(buildFakeRom(i => (i === 5 ? ptr : FILLER)))
    expect(catalog.entries[5]).toMatchObject({ pointed, isReal: pointed })
    if (!pointed) expect(catalog.entries[5]!.parseable).toBe(false)
  })

  it('marks every slot on the most common pointer pointed and shared, but not real', () => {
    const catalog = buildLevelCatalog(buildFakeRom(i => (i < 100 ? FILLER : 0x038000 + i)))
    const shared = catalog.entries.slice(0, 100)
    expect(shared.every(e => e.pointed && e.sharedPointer && !e.isReal)).toBe(true)
    expect(catalog.sharedPointerCount).toBe(100)
    expect(catalog.entries.slice(100).every(e => e.pointed && !e.sharedPointer && e.isReal)).toBe(
      true,
    )
  })

  // F3: a stream is readable when it reaches its end marker, not merely when five bytes fit.
  it('marks a pointed slot terminated only when its stream reaches the end marker', () => {
    // The readable one sits lowest: a walk from a higher pointer never reaches its end marker.
    const READABLE = 0x018000
    const NO_END = 0x068000 // zero bytes: 3-byte objects to the end of the file
    const catalog = buildLevelCatalog(
      buildFakeRom(i => (i === 0 ? READABLE : i === 1 ? NO_END : 0x078000), new Set([READABLE])),
    )
    expect(catalog.entries[0]).toMatchObject({ parseable: true, terminated: true })
    expect(catalog.entries[1]).toMatchObject({ pointed: true, parseable: true, terminated: false })
    expect(catalog.entries[2]!.terminated).toBe(false) // the shared room has no end marker either
    expect(catalog.entries[5]!.terminated).toBe(false)
  })

  it('gives every slot on one pointer the same answer, walking that stream once', () => {
    const SHARED_READABLE = 0x048000
    const rom = buildFakeRom(() => SHARED_READABLE, new Set([SHARED_READABLE]))
    const walks = vi.spyOn(rom, 'isLevelStreamTerminated')
    const catalog = buildLevelCatalog(rom)
    expect(catalog.entries.every(e => e.terminated)).toBe(true)
    expect(walks).toHaveBeenCalledTimes(1)
    const bad = buildLevelCatalog(buildFakeRom(() => 0x058000))
    expect(bad.entries.some(e => e.terminated)).toBe(false)
  })

  // F2: a pointer that makes slots New must not be picked as the common pointer.
  it('ignores pointers outside the file when choosing the common one', () => {
    const REAL = 0x068000
    const READABLE = new Set([REAL])
    const catalog = buildLevelCatalog(
      buildFakeRom(i => (i < 20 ? 0x7e8000 : i < 35 ? REAL : 0), READABLE),
    )
    expect(catalog.fillerPointer).toBe(REAL)
    expect(catalog.sharedPointerCount).toBe(15)
    expect(catalog.realCount + catalog.sharedPointerCount).toBe(15)
    expect(catalog.entries.filter(e => e.sharedPointer && !e.pointed)).toEqual([])
    expect(catalog.entries.slice(0, 20).every(e => !e.pointed && !e.isReal)).toBe(true)
  })

  it('omits the partial-parse note when every real slot reads back', () => {
    const READABLE = 0x048000
    const rom = buildFakeRom(i => (i === 0 ? READABLE : FILLER), new Set([READABLE]))
    const catalog = buildLevelCatalog(rom)
    expect(catalog.realCount - catalog.parseableCount).toBe(0)
    expect(catalog.notes).toHaveLength(0)
  })

  describe('filler-confidence guard (fails safe instead of silently inverting)', () => {
    it('flags low confidence when the mode is a reused real sublevel, not the true filler', () => {
      // 300 slots share one real sublevel's pointer; 212 slots share the
      // ROM's actual filler. Pointer-counting alone cannot tell these apart
      // -- the mode heuristic picks the larger group -- but the margin
      // (300 vs. 212) is too thin to trust silently, so a note must appear.
      const REUSED_REAL = 0x058000
      const rom = buildFakeRom(i => (i < 300 ? REUSED_REAL : FILLER))
      const catalog = buildLevelCatalog(rom)
      expect(catalog.fillerPointer).toBe(REUSED_REAL) // the inversion: mode != true filler
      expect(catalog.realCount).toBe(212) // true real/filler roles are swapped
      expect(catalog.notes.length).toBeGreaterThan(0)
    })

    it('flags low confidence with the order reversed: the runner-up is counted when it comes second', () => {
      // 212 slots on FILLER come first, then 300 on REUSED_REAL: the larger group is
      // seen second, so the runner-up count is carried over from the displaced best.
      const REUSED_REAL = 0x058000
      const rom = buildFakeRom(i => (i < 212 ? FILLER : REUSED_REAL))
      const catalog = buildLevelCatalog(rom)
      expect(catalog.fillerPointer).toBe(REUSED_REAL)
      expect(catalog.notes.join(' ')).toMatch(/another by 212\./)
    })

    // The share floor is 10% of 512 = 51.2 slots: 51 is under it, 52 is over. The runner-up
    // (9) keeps the margin check silent either side, so only the share floor can fire.
    it.each([
      [51, true],
      [52, false],
    ])('%i slots on the most common pointer of 512: low-confidence note is %s', (n, fires) => {
      const rom = buildFakeRom(i => (i < n ? FILLER : i < n + 9 ? RUNNER_UP : 0x038000 + i))
      const catalog = buildLevelCatalog(rom)
      expect(catalog.fillerPointer).toBe(FILLER)
      expect(/Not sure which maps share level data/.test(catalog.notes.join(' '))).toBe(fires)
    })

    it('stays silent on the confidence check with a wide margin and a share above a tenth', () => {
      // 100 of 512 (19.5%), runner-up 9: neither the share floor nor the margin ratio applies.
      const rom = buildFakeRom(i => (i < 100 ? FILLER : i < 109 ? RUNNER_UP : 0x038000 + i))
      const catalog = buildLevelCatalog(rom)
      expect(catalog.fillerPointer).toBe(FILLER)
      expect(catalog.notes.join(' ')).not.toMatch(/Not sure which maps share level data/)
    })

    it('names no common pointer when every pointer is distinct, and every slot is real', () => {
      // Was: the no-threshold mode picked pointers[0] and a note flagged it. The >=10
      // rule (findCommonPointer) now declines, so nothing is invented as filler.
      const rom = buildFakeRom(i => 0x038000 + i)
      const catalog = buildLevelCatalog(rom)
      expect(catalog.fillerPointer).toBe(0)
      expect(catalog.sharedPointerCount).toBe(0)
      expect(catalog.realCount).toBe(LEVEL_COUNT)
    })

    it('stays silent on a comfortable corpus-shaped margin', () => {
      // Shaped like the real corpus: filler dominates, nothing else repeats,
      // and the real slots all parse -- so no note of any kind is expected.
      const READABLE = 0x048000
      const rom = buildFakeRom(i => (i < 12 ? READABLE : FILLER), new Set([READABLE]))
      const catalog = buildLevelCatalog(rom)
      expect(catalog.notes).toHaveLength(0)
    })
  })

  describe('the catalog and the exit graph agree on the most common pointer (#901, #949)', () => {
    // SmwRom's private detector feeds the exit graph; reached through a cast because
    // the point is that both consumers use one rule.
    const graphCommon = (rom: SmwRom): number | null =>
      (rom as unknown as { _findFillerL1Pointer(): number | null })._findFillerL1Pointer()

    it.each([12, 10, 9])('%i slots sharing one pointer, the rest unique', n => {
      const SHARED = 0x078000
      const rom = buildFakeRom(i => (i < n ? SHARED : 0x038000 + i))
      const catalog = buildLevelCatalog(rom)
      const expected = n >= 10 ? SHARED : null
      expect(graphCommon(rom)).toBe(expected)
      expect(catalog.fillerPointer).toBe(expected ?? 0)
      expect(catalog.entries.filter(e => e.sharedPointer).length).toBe(expected ? n : 0)
      // Below the threshold no pointer is common, so every pointed slot is real.
      expect(catalog.realCount).toBe(expected ? LEVEL_COUNT - n : LEVEL_COUNT)
    })

    it('a most common pointer repeating only 9 times names no common pointer', () => {
      const rom = buildFakeRom(i => (i < 9 ? 0x078000 : i < 17 ? 0x079000 : 0x038000 + i))
      expect(graphCommon(rom)).toBeNull()
      expect(buildLevelCatalog(rom).realCount).toBe(LEVEL_COUNT)
    })
  })

  describe('teeth: acceptance gate rejects broken catalogs', () => {
    const READABLE = 0x048000
    // Index 0 must be real: assertCatalogAcceptance treats slot $000 as a
    // known-real member (true on every ROM in the corpus, see report).
    const rom = buildFakeRom(i => (i < 12 ? READABLE : FILLER), new Set([READABLE]))
    const good = buildLevelCatalog(rom)
    const expectedReal = good.realCount
    const expectedParseable = good.parseableCount
    const variants = buildBrokenCatalogVariants(good)

    it('the real catalog passes', () => {
      expect(() => assertCatalogAcceptance(good, expectedReal, expectedParseable)).not.toThrow()
    })

    // Runs with no cart, which is where it is needed: the ROM-gated sweep
    // names its 24 cases from BROKEN_VARIANT_NAMES, so a variant renamed here
    // would silently stop being swept there.
    it('the declared variant names match what the builder returns', () => {
      assertVariantNames(variants)
    })

    for (const [name, broken] of Object.entries(variants)) {
      it(`${name} fails`, () => {
        expect(() => assertCatalogAcceptance(broken, expectedReal, expectedParseable)).toThrow()
      })
    }
  })
})

describe('findCommonPointer tie-break', () => {
  it('on equal counts the pointer first in slot order wins', () => {
    const A = 0x018000
    const B = 0x028000
    const pointers = Array.from({ length: LEVEL_COUNT }, (_, i) =>
      i < 12 ? A : i < 24 ? B : 0x038000 + i,
    )
    expect(findCommonPointer(pointers)).toEqual({ pointer: A, count: 12, runnerUpCount: 12 })
  })
})
