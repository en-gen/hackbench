import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { loromToOffset } from '../../../src/rom/addressing'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { assertCatalogAcceptance, buildBrokenCatalogVariants } from '../support/catalogAcceptance'

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
    const UNREADABLE = 0x3f8000 // maps past the end of this small synthetic buffer
    const rom = buildFakeRom(
      i => (i === 0 ? READABLE : i === 1 ? UNREADABLE : FILLER),
      new Set([READABLE]),
    )
    const catalog = buildLevelCatalog(rom)
    expect(catalog.entries[0]).toMatchObject({ isReal: true, parseable: true })
    expect(catalog.entries[1]).toMatchObject({ isReal: true, parseable: false })
    expect(catalog.parseableCount).toBe(1)
    // realCount - parseableCount is the machine-readable gap; a note exists
    // to surface it in a UI, but tests assert on the counts, not its wording.
    expect(catalog.realCount - catalog.parseableCount).toBe(1)
    expect(catalog.notes.length).toBeGreaterThan(0)
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

    it('flags low confidence when every pointer is distinct', () => {
      // No pointer repeats at all, so the "mode" is just pointers[0] by
      // construction -- its share of 512 is a rounding error and must not
      // be reported as a real filler without comment.
      const rom = buildFakeRom(i => 0x038000 + i)
      const catalog = buildLevelCatalog(rom)
      expect(catalog.fillerPointer).toBe(0x038000)
      expect(catalog.notes.length).toBeGreaterThan(0)
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

    for (const [name, broken] of Object.entries(variants)) {
      it(`${name} fails`, () => {
        expect(() => assertCatalogAcceptance(broken, expectedReal, expectedParseable)).toThrow()
      })
    }
  })
})
