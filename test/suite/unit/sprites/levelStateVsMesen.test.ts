/**
 * #649 step 1: pins WHERE the ROM-run level loader (LevelLoader.ts) disagrees with the Mesen
 * sprite-trace captures, so a change inside a differing map, or one that moves a map between
 * the identical and different sets, goes red. Measurement only: the pinned values are known
 * differences, not correct behaviour. Cause analysis and tile-pair buckets are on the issue.
 * Measured 2026-10-07, vanilla ROM, 154 captured maps (ids are hex level numbers). The Mesen
 * $94/$96 is the first sprite-call WRAM snapshot, not load time.
 */
import { createHash } from 'node:crypto'
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { readMarioStartPos } from '../../../../src/rom/L3Loader'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { freshRom, hasRom, romPath, TOOLS_ROOT, VANILLA } from '../../support/corpus'

const TRACE_DIR = process.env.HACKBENCH_SPRITE_TRACE ?? join(TOOLS_ROOT, 'fixtures', 'sprite-trace')
// The capture directory is named for the first 8 hex digits of the ROM's SHA-1.
const sha8 = (): string =>
  createHash('sha1')
    .update(readFileSync(romPath(VANILLA)))
    .digest('hex')
    .slice(0, 8)
const root = hasRom(VANILLA) ? join(TRACE_DIR, sha8()) : ''

/** One map: the loader's WRAM, the captured Map16 tables, the capture's $94..$97 (if recorded). */
interface In { id: string; wram: Uint8Array; lo: Buffer; hi: Buffer; levelEnd: number; mario: Buffer | null } // prettier-ignore

/** Differing 16-bit tiles per map, and the maps whose every difference is the loader's $25 past the level where the capture holds $0000. */
function map16Differences(ins: In[]): { counts: string[]; pastEndOnly: string[] } {
  const counts: string[] = []
  const pastEndOnly: string[] = []
  for (const m of ins) {
    let n = 0
    let other = false
    for (let i = 0; i < m.lo.length; i++) {
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

const pins = (s: string): string[] => s.split(' ')
const MAP16_COUNTS = pins(
  '002:2816 004:713 007:982 00b:1404 00e:964 013:1017 01a:2854 01b:1266 01f:855 020:4599 021:530 093:231 094:228 095:64 096:32 097:32 098:64 099:64 09a:64 09b:32 0be:185 0bf:147 0c1:121 0c4:288 0c8:137 0cb:106 0cc:64 0d3:228 0d4:2198 0d5:64 0d6:4381 0d9:64 0db:1863 101:1982 102:2816 107:722 10d:1006 10e:1745 110:1759 111:3336 114:740 11c:2664 11d:1804 127:2816 193:228 194:231 195:64 196:32 197:32 198:64 199:64 19a:64 19b:32 1bd:1736 1c7:32 1cc:623 1cd:553 1ce:1103 1cf:1111 1d0:1011 1d1:288 1d3:760 1d4:496 1d9:740 1da:288 1db:793',
)
const PAST_END = ['002', '102', '127']
const LOADER_VS_MESEN = pins(
  '095:-16,256 096:-64,-65136 097:-64,-65136 098:-16,256 099:-16,256 09a:-16,256 09b:-16,256 0cc:-16,256 0d5:-16,256 0d9:-16,256 195:-16,256 196:-64,-65136 197:-64,-65136 198:-16,256 199:-16,256 19a:-16,256 19b:-16,256 1c7:-16,256',
)
const FALLBACK_VS_LOADER = pins(
  '00a:-8,0 00b:-8,0 011:-8,0 018:-8,0 0be:-8,0 0bf:-8,0 0c0:-8,0 0c1:-776,0 0c2:-8,-768 0c3:-8,0 0c6:-8,0 0d0:-4104,-2 0d1:-1800,-2 0d2:-8,0 0d7:-8,0 0d8:-1032,0 0db:0,-768 102:0,80 109:0,-1280 10a:112,80 10d:112,16 10f:0,32 110:0,-256 115:112,-48 116:112,-80 119:112,128 120:-8,0 123:208,-96 12a:0,-1024 12c:208,0 130:-8,0 1be:-8,0 1bf:-768,0 1c0:-8,0 1c1:-776,0 1c4:-264,0 1c5:-8,0 1c6:-8,0 1ca:-8,0 1ce:-8,-1024 1d5:-8,0 1d9:-768,0 1db:-768,0',
)

describe.skipIf(!hasRom(VANILLA) || !existsSync(root))(
  'level state vs Mesen: known differences (#649)',
  () => {
    let cached: In[] | undefined
    const real = (): In[] => {
      if (cached) return cached
      const rom = freshRom()
      const smw = new SmwRom(rom)
      return (cached = readdirSync(root).sort().map(id => {
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
      expect(r.counts.length).toBe(66)
      expect(r.pastEndOnly).toEqual(PAST_END)
    }, 300_000)

    it('Mario: the loader $94/$96 differs from the capture on exactly the pinned 18 maps, by these offsets', () => {
      expect(real().filter(m => m.mario).length).toBe(98)
      expect(loaderVsMesen(real())).toEqual(LOADER_VS_MESEN)
    }, 300_000)

    it("Mario: readMarioStartPos (the generic-seed fallback) falls short of the loader's $94/$96 on the pinned maps", () => {
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
    return map16Differences([m])
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

  it('readMarioStartPos reads the secondary entrance, its X index from bits 7-5, and the X high byte', () => {
    const rom = RomFile.fromBytes('s.sfc', Buffer.alloc(0x100000))
    for (let i = 0; i < 16; i++) rom.writeAt(0x05d730 + i, [0x30 + i]) // Y low
    rom.writeAt(0x05d740 + 4, [1]) // Y high, index 4
    for (let i = 0; i < 8; i++) rom.writeAt(0x05d750 + i, [0x20 + i * 8]) // X low
    rom.writeAt(0x05d758 + 2, [1]) // X high, index 2: an X above 224
    rom.writeAt(0x05f000 + 5, [3]) // level $05, primary: Y index 3
    rom.writeAt(0x05f200 + 5, [5]) // X index 5
    rom.writeAt(0x05f000 + 0x105, [3])
    rom.writeAt(0x05f200 + 0x105, [5]) // the same primary bytes for $105, so ignoring the entrance shows
    rom.writeAt(0x05f800 + 3, [0x05]) // secondary entrance 3 targets $105 (low byte; high bit is in $FC00)
    rom.writeAt(0x05fc00 + 3, [(2 << 5) | 1]) // X index 2, target high bit 1
    rom.writeAt(0x05fa00 + 3, [4]) // Y index 4
    expect(readMarioStartPos(rom, 0x05)).toEqual({ x: 0x48, y: 0x33 })
    expect(readMarioStartPos(rom, 0x105)).toEqual({ x: 0x130, y: 0x134 })
  })
})
