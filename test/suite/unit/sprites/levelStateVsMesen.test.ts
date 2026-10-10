/**
 * #649 step 1: pins WHERE the ROM-run level loader (LevelLoader.ts) disagrees with the Mesen
 * sprite-trace captures, so a change inside a differing map, or one that moves a map between
 * the identical and different sets, goes red. Measurement only: the pinned values are known
 * differences, not correct behaviour. Cause analysis and tile-pair buckets are on the issue.
 * Measured 2026-10-09, vanilla ROM, one machine, 154 captured maps (ids are hex map slot indices),
 * against the set re-captured at the real level load (SPRITE_TRACE_SET; the 45 castle-entry maps were
 * re-run with the fixed harness, the rest copied unchanged). Before that, 66 maps differed. The Mesen
 * $94/$96 is the first sprite-call WRAM snapshot, not load time.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { readMarioStartPos } from '../../../../src/rom/MarioStartPos'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { freshRom, hasRom, SPRITE_TRACE_SET, TOOLS_ROOT, VANILLA } from '../../support/corpus'

const TRACE_DIR = process.env.HACKBENCH_SPRITE_TRACE ?? join(TOOLS_ROOT, 'fixtures', 'sprite-trace')
const root = hasRom(VANILLA) ? join(TRACE_DIR, SPRITE_TRACE_SET) : ''

/** Bytes in each Map16 table (the object interpreter buffer, objectHandlers/interpret.ts BUF_LEN). */
const MAP16_LEN = 0x3800

/** One map: the loader's WRAM, the captured Map16 tables, the capture's $94..$97 (if recorded). */
interface In { id: string; wram: Uint8Array; lo: Buffer; hi: Buffer; levelEnd: number; mario: Buffer | null } // prettier-ignore

/** Differing 16-bit tiles per map, and the maps whose every difference is the loader's $25 past the level where the capture holds $0000. */
function map16Differences(ins: In[], len = MAP16_LEN): { counts: string[]; pastEndOnly: string[] } {
  const counts: string[] = []
  const pastEndOnly: string[] = []
  for (const m of ins) {
    // A short capture or loader buffer would compare fewer cells and could pass.
    if (m.lo.length !== len || m.hi.length !== len || m.wram.length < 0x1c800 + len)
      throw new Error(`${m.id}: Map16 buffers are not the full ${len}-byte table`)
    let n = 0
    let other = false
    for (let i = 0; i < len; i++) {
      const got = (m.wram[0x1c800 + i]! << 8) | m.wram[0xc800 + i]!
      const cap = (m.hi[i]! << 8) | m.lo[i]!
      if (got === cap) continue
      n++
      if (cap !== 0 || got !== 0x25 || i < m.levelEnd) other = true
    }
    if (n === 0) continue
    counts.push(`${m.id}:${n}`)
    if (!other) pastEndOnly.push(m.id)
  }
  return { counts, pastEndOnly }
}

const xy = (b: Uint8Array, o: number) => ({ x: b[o]! | (b[o + 1]! << 8), y: b[o + 2]! | (b[o + 3]! << 8) }) // prettier-ignore
const gap = (id: string, a: { x: number; y: number }, b: { x: number; y: number }): string =>
  `${id}:${a.x - b.x},${a.y - b.y}`
const nonzero = (s: string): boolean => !s.endsWith(':0,0')

/** Loader $94/$96 minus the capture's, on maps where they differ. */
const loaderVsMesen = (ins: In[]): string[] =>
  ins.filter(m => m.mario).map(m => gap(m.id, xy(m.wram, 0x94), xy(m.mario!, 0))).filter(nonzero) // prettier-ignore

/** The generic-seed fallback (readMarioStartPos) minus the loader's $94/$96, on maps where they differ. */
const fallbackVsLoader = (rom: RomFile, ins: In[]): string[] =>
  ins.map(m => gap(m.id, readMarioStartPos(rom, parseInt(m.id, 16)), xy(m.wram, 0x94))).filter(nonzero) // prettier-ignore

/** A map's Level 1 pointer and its Map16 dump, for the shared-image check. */
interface Dump { id: string; ptr: number; lo: Buffer; hi: Buffer } // prettier-ignore

/**
 * Groups of maps with DIFFERENT Level 1 pointers whose Map16 dumps are byte-identical. Before the
 * #649 harness fix, 45 maps opened on the castle-entry scene and shared three fixed images
 * (groups of 30, 10 and 5), so a new group here is suspect. Some groups are legitimate (SHARED_IMAGES).
 */
function sharedImages(ds: Dump[]): string[][] {
  const by = new Map<string, Dump[]>()
  for (const d of ds) {
    const k = createHash('md5').update(d.lo).update(d.hi).digest('hex')
    by.set(k, [...(by.get(k) ?? []), d])
  }
  return [...by.values()].filter(g => new Set(g.map(d => d.ptr)).size > 1).map(g => g.map(d => d.id)) // prettier-ignore
}

/** Map folders of a capture set (the set also holds a PROVENANCE.md). */
const maps = (root: string): string[] =>
  readdirSync(root, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name).sort() // prettier-ignore

const pins = (s: string): string[] => s.split(' ')
const MAP16_COUNTS = pins(
  '002:2816 095:64 096:32 097:32 098:64 099:64 09a:64 09b:32 0be:2816 0c1:2816 0cc:64 0d5:64 0d9:64 102:2816 127:2816 195:64 196:32 197:32 198:64 199:64 19a:64 19b:32 1c7:32',
)
// Level-independent dumps that different pointers legitimately share: the mode 9 and mode 16 boss
// arenas (the capture holds the game's arena fill; these are the maps in MAP16_COUNTS above), and
// 094/193/0d3, one-screen rooms that match the loader cell for cell. A castle-entry image would add
// a 30-, 10- or 5-map group here; anything new is red.
const SHARED_IMAGES = [
  ['094', '0d3', '193'],
  ['095', '098', '099', '09a', '0cc', '0d5', '0d9', '195', '198', '199', '19a'],
  ['09b', '19b', '1c7'],
]
const PAST_END = ['002', '0be', '0c1', '102', '127']
const LOADER_VS_MESEN = pins(
  '095:-16,256 096:-64,-65136 097:-64,-65136 098:-16,256 099:-16,256 09a:-16,256 09b:-16,256 0cc:-16,256 0d5:-16,256 0d9:-16,256 195:-16,256 196:-64,-65136 197:-64,-65136 198:-16,256 199:-16,256 19a:-16,256 19b:-16,256 1c7:-16,256',
)
// After #781 (entrance screen and entrance-type nudge in Mario's position) 17 of the 154 differ, was 52: every one
// a sub area where this reads the secondary entrance (the play path) and the loader, which leaves UseSecondaryExit
// 0, the primary bytes. Full 512-map sweep: MarioStartPos.test.ts.
const FALLBACK_VS_LOADER = pins(
  '102:1288,80 103:2168,-48 105:2056,-46 106:4312,0 10a:3952,80 10b:2672,-128 10f:776,32 113:2056,-80 116:2424,-80 117:1656,0 118:4104,240 119:3960,128 11a:3696,0 11f:2264,-16 123:1032,-32 127:2680,-16 12c:2520,0',
)

describe.skipIf(!hasRom(VANILLA) || !existsSync(root))(
  'level state vs Mesen: known differences (#649)',
  () => {
    let cached: In[] | undefined
    const real = (): In[] => {
      if (cached) return cached
      const rom = freshRom()
      const smw = new SmwRom(rom)
      return (cached = maps(root).map(id => {
        const l = loadLevelState(rom, parseInt(id, 16))
        if (!l.ok) throw new Error(`${id}: ${l.reason}`)
        const wp = join(root, id, 'wram.bin')
        const w = existsSync(wp) ? readFileSync(wp) : null
        // Horizontal screens are $1B0 bytes; the pinned past-end maps are mode 0.
        const len = parseLevelHeader(smw.getLevelRawData(parseInt(id, 16))!).levelLength
        return {
          id, wram: l.wram, levelEnd: len * 0x1b0,
          lo: readFileSync(join(root, id, 'map16_7ec800.bin')),
          hi: readFileSync(join(root, id, 'map16_7fc800.bin')),
          mario: w && w.length >= 0x98 ? w.subarray(0x94, 0x98) : null,
        }
      })) // prettier-ignore
    }
    /** `real()` with one map edited on a copy; the cached inputs stay clean. */
    const plant = (id: string, f: (m: In) => void): In[] =>
      real().map(m => {
        if (m.id !== id) return m
        const c = { ...m, wram: m.wram.slice(), lo: Buffer.from(m.lo), hi: Buffer.from(m.hi) }
        f(c)
        return c
      })
    const changedIds = (a: string[], b: string[]): string[] =>
      [...new Set([...a, ...b].filter(x => !(a.includes(x) && b.includes(x))).map(x => x.split(':')[0]!))].sort() // prettier-ignore

    it('Map16: every differing map and its differing-tile count are pinned', () => {
      expect(real().length).toBe(154)
      const r = map16Differences(real())
      expect(r.counts).toEqual(MAP16_COUNTS)
      expect(r.counts.length).toBe(23)
      expect(r.pastEndOnly).toEqual(PAST_END)
    }, 300_000)

    it('no two maps with different Level 1 pointers share a Map16 dump (no castle-entry image survives)', () => {
      const ds: Dump[] = maps(root).map(id => ({
        id,
        ptr: JSON.parse(readFileSync(join(root, id, 'meta.json'), 'utf8')).layer1Ptr as number,
        lo: readFileSync(join(root, id, 'map16_7ec800.bin')),
        hi: readFileSync(join(root, id, 'map16_7fc800.bin')),
      })) // prettier-ignore
      expect(ds.length).toBe(154)
      expect(sharedImages(ds)).toEqual(SHARED_IMAGES)
    })

    it('Mario: the loader $94/$96 differs from the capture on exactly the pinned 18 maps, by these offsets', () => {
      expect(real().filter(m => m.mario).length).toBe(139)
      expect(loaderVsMesen(real())).toEqual(LOADER_VS_MESEN)
    }, 300_000)

    it("Mario: readMarioStartPos (the generic-seed fallback) differs from the loader's $94/$96 only on the pinned sub areas", () => {
      expect(fallbackVsLoader(freshRom(), real())).toEqual(FALLBACK_VS_LOADER)
    }, 300_000)

    it('plants inside differing and identical maps, in either table and either source, go red', () => {
      // A flip inside an already-differing cell can leave its count unchanged, so plant on an equal cell.
      const same = (m: In): number =>
        m.lo.findIndex(
          (_, i) =>
            ((m.wram[0x1c800 + i]! << 8) | m.wram[0xc800 + i]!) === ((m.hi[i]! << 8) | m.lo[i]!),
        )
      const base = map16Differences(real()).counts
      const flip = (id: string, f: (m: In) => void) => changedIds(base, map16Differences(plant(id, f)).counts) // prettier-ignore
      expect(flip('004', m => (m.wram[0xc800 + same(m)]! ^= 1))).toEqual(['004']) // loader, differing map
      expect(flip('004', m => (m.lo[same(m)]! ^= 1))).toEqual(['004']) // capture, differing map
      expect(flip('1c5', m => (m.lo[same(m)]! ^= 1))).toEqual(['1c5']) // capture, identical map
      expect(flip('020', m => (m.hi[same(m)]! ^= 1))).toEqual(['020']) // the hi table
    }, 300_000)

    it('plants that break the past-end reading drop the map from it', () => {
      const past = (id: string, f: (m: In) => void) => map16Differences(plant(id, f)).pastEndOnly
      expect(past('002', m => (m.lo[0x200] = 0))).not.toContain('002') // $25 to $00 inside the level
      // The 2816 past-end cells are rows $10-$1A of screens 16-31 on all 5 maps. The capture holds
      // $0000 there (game state written after the load, writer not identified); the loader's $25 is
      // the table fill (bank_05.asm:58-65). A new $0000 past 0be's end (4 screens, 1728) is still past-end.
      expect(past('0be', m => (m.lo[0x1000] = 0))).toContain('0be')
      // 002 is 16 screens, so its end is $1B00: just past it is past-end, the last cell inside it is not.
      expect(past('002', m => (m.lo[0x1b80] = 0))).toContain('002')
      expect(past('002', m => (m.lo[0x1aff] = 0))).not.toContain('002')
      expect(past('002', m => ((m.lo[0x150] = 0), (m.hi[0x150] = 1)))).not.toContain('002') // capture $100
      expect(past('002', m => (m.hi[0x1c00] = 1))).not.toContain('002') // $100, past the end, not $0000
      expect(past('002', m => (m.wram[0xc800 + 0x1c00] = 0x26))).not.toContain('002') // loader not $25
    }, 300_000)

    it('Mario plants go red: the loader $94 and the table X', () => {
      const id = real().find(m => m.mario && !loaderVsMesen([m]).length)!.id
      expect(loaderVsMesen(plant(id, m => (m.wram[0x94]! += 8)))).not.toEqual(LOADER_VS_MESEN)
      const rom = freshRom()
      rom.writeAt(0x05d750, [0x55])
      expect(fallbackVsLoader(rom, real())).not.toEqual(FALLBACK_VS_LOADER)
    }, 300_000)
  },
)

// No ROM needed: bytes built here, so these run in CI.
describe('level state comparators on synthetic bytes', () => {
  const syn = (f?: (m: In) => void): { counts: string[]; pastEndOnly: string[] } => {
    const m: In = { id: 'x', wram: new Uint8Array(0x30000), lo: Buffer.alloc(8), hi: Buffer.alloc(8), levelEnd: 4, mario: null } // prettier-ignore
    for (let i = 0; i < 8; i++) {
      m.wram[0xc800 + i] = 0x25
      m.lo[i] = 0x25
    }
    f?.(m)
    return map16Differences([m], 8)
  }
  it('Map16 compare sees either table, and reads the past-end rule on 16-bit tiles', () => {
    expect(syn()).toEqual({ counts: [], pastEndOnly: [] })
    expect(syn(m => (m.lo[1]! ^= 1)).counts).toEqual(['x:1'])
    expect(syn(m => (m.hi[1] = 1)).counts).toEqual(['x:1'])
    expect(syn(m => (m.wram[0x1c800 + 1] = 1)).counts).toEqual(['x:1'])
    const pastEnd = (i: number, f: (m: In) => void) => syn(m => ((m.lo[i] = 0), f(m))).pastEndOnly
    expect(pastEnd(5, () => {})).toEqual(['x'])
    expect(pastEnd(3, () => {})).toEqual([]) // inside the level
    expect(pastEnd(5, m => (m.hi[5] = 1))).toEqual([]) // capture $100
    expect(pastEnd(5, m => (m.wram[0xc800 + 5] = 0x26))).toEqual([]) // loader not $25
  })

  it('shared-image check goes red on a planted duplicate, and ignores maps with the same pointer', () => {
    const mk = (id: string, ptr: number, b: number): Dump => ({ id, ptr, lo: Buffer.alloc(8, b), hi: Buffer.alloc(8, 0) }) // prettier-ignore
    expect(sharedImages([mk('a', 1, 1), mk('b', 2, 2), mk('c', 3, 3)])).toEqual([])
    expect(sharedImages([mk('a', 1, 1), mk('b', 2, 1), mk('c', 3, 3)])).toEqual([['a', 'b']])
    expect(sharedImages([mk('a', 1, 1), mk('b', 1, 1)])).toEqual([]) // same pointer: outside this different-pointer check
    const m = mk('b', 2, 1)
    m.hi[7] = 1 // one byte in the hi table is enough to be a different image
    expect(sharedImages([mk('a', 1, 1), m])).toEqual([])
  })

  it('Map16 compare refuses a truncated or empty table instead of comparing fewer cells', () => {
    const m: In = { id: 'x', wram: new Uint8Array(0x30000), lo: Buffer.alloc(MAP16_LEN), hi: Buffer.alloc(MAP16_LEN), levelEnd: 0, mario: null } // prettier-ignore
    for (const bad of [
      { lo: Buffer.alloc(8) },
      { hi: Buffer.alloc(0) },
      { wram: new Uint8Array(0x1c800) },
    ])
      expect(() => map16Differences([{ ...m, ...bad }])).toThrow(/full 14336-byte table/)
    expect(map16Differences([m]).counts).toEqual([])
  })

  // The 3-bit X index is swept, each with a distinct X; odd indexes carry an X high byte (X above 224).
  it.each([0, 1, 2, 3, 4, 5, 6, 7])('readMarioStartPos secondary entrance, X index %i', k => {
    const rom = RomFile.fromBytes('s.sfc', Buffer.alloc(0x100000))
    for (let i = 0; i < 16; i++) rom.writeAt(0x05d730 + i, [0x30 + i]) // Y low
    rom.writeAt(0x05d740 + 4, [1]) // Y high, index 4
    for (let i = 0; i < 8; i++) {
      rom.writeAt(0x05d750 + i, [0x20 + i * 8]) // X low
      rom.writeAt(0x05d758 + i, [i & 1]) // X high
    }
    rom.writeAt(0x05f000 + 5, [3]) // level $05, primary: Y index 3
    rom.writeAt(0x05f200 + 5, [5]) // X index 5
    rom.writeAt(0x05f000 + 0x105, [3])
    rom.writeAt(0x05f200 + 0x105, [5]) // the same primary bytes for $105, so ignoring the entrance shows
    rom.writeAt(0x05f800 + 0x103, [0x05]) // secondary entrance $103 targets $105 (index bit 8 = the map's bit 8)
    rom.writeAt(0x05fc00 + 0x103, [(k << 5) | 1]) // X index k, screen 1
    rom.writeAt(0x05fa00 + 0x103, [4]) // Y index 4
    // Horizontal: the entrance's screen (here 1, FC00 bit 0) replaces the X high byte (bank_05.asm:7382-7383).
    expect(readMarioStartPos(rom, 0x05)).toEqual({ x: 0x48, y: 0x33 })
    expect(readMarioStartPos(rom, 0x105)).toEqual({ x: 0x100 + 0x20 + k * 8, y: 0x134 })
    // Vertical (DATA_05F600 bit 5): the screen goes to Y and X keeps its DATA_05D758 high byte.
    rom.writeAt(0x05f600 + 0x105, [0x20])
    expect(readMarioStartPos(rom, 0x105)).toEqual({
      x: 0x20 + k * 8 + (k & 1) * 0x100,
      y: 0x100 + 0x34,
    })
  })
})
