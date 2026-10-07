/**
 * #649 step 1: pins WHICH maps the ROM-run level loader (LevelLoader.ts) disagrees with the
 * Mesen sprite-trace captures on, so a loader change that moves a map between the identical
 * and different sets goes red. Measurement only: the pinned sets are known differences, not
 * correct behaviour. Cause analysis and the tile-pair buckets are on the issue.
 * Measured 2026-10-07, vanilla ROM, 154 captured maps (ids are hex level numbers).
 */
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { readMarioStartPos } from '../../../../src/rom/L3Loader'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import type { RomFile } from '../../../../src/rom/RomFile'
import { freshRom, hasRom, TOOLS_ROOT, VANILLA } from '../../support/corpus'

const TRACE_DIR = process.env.HACKBENCH_SPRITE_TRACE ?? join(TOOLS_ROOT, 'fixtures', 'sprite-trace')
const root = existsSync(TRACE_DIR) ? join(TRACE_DIR, readdirSync(TRACE_DIR)[0] ?? 'none') : ''
const maps = (): string[] => readdirSync(root).sort()

/** True when the two Map16 tables differ anywhere in the captured length. */
function tablesDiffer(lo: Buffer, hi: Buffer, wram: Uint8Array): boolean {
  return (
    Buffer.compare(Buffer.from(wram.subarray(0xc800, 0xc800 + lo.length)), lo) !== 0 ||
    Buffer.compare(Buffer.from(wram.subarray(0x1c800, 0x1c800 + hi.length)), hi) !== 0
  )
}

/** Maps whose loader tables differ from capture, and those whose every differing byte is a 0 in the capture. */
function map16Differences(rom: RomFile): {
  diff: string[]
  capturedZeroOnly: string[]
  total: number
} {
  // prettier-ignore
  const diff: string[] = []
  const capturedZeroOnly: string[] = []
  const all = maps()
  for (const map of all) {
    const l = loadLevelState(rom, parseInt(map, 16))
    if (!l.ok) throw new Error(`${map}: ${l.reason}`)
    const lo = readFileSync(join(root, map, 'map16_7ec800.bin'))
    const hi = readFileSync(join(root, map, 'map16_7fc800.bin'))
    if (!tablesDiffer(lo, hi, l.wram)) continue
    diff.push(map)
    const only0 = lo.every((b, i) => (l.wram[0xc800 + i] === b || b === 0) && (l.wram[0x1c800 + i] === hi[i] || hi[i] === 0)) // prettier-ignore
    if (only0) capturedZeroOnly.push(map)
  }
  return { diff, capturedZeroOnly, total: all.length }
}

/** Maps with a recorded WRAM image whose $94/$96 differ from the table-read start. */
function marioDifferences(rom: RomFile): { diff: string[]; compared: number } {
  const diff: string[] = []
  let compared = 0
  for (const map of maps()) {
    const wp = join(root, map, 'wram.bin')
    if (!existsSync(wp)) continue
    const w = readFileSync(wp)
    if (w.length < 0x98) continue
    compared++
    const m = readMarioStartPos(rom, parseInt(map, 16))
    if (m.x !== (w[0x94]! | (w[0x95]! << 8)) || m.y !== (w[0x96]! | (w[0x97]! << 8))) diff.push(map)
  }
  return { diff, compared }
}

const MAP16_DIFFERENT =
  '002 004 007 00b 00e 013 01a 01b 01f 020 021 093 094 095 096 097 098 099 09a 09b 0be 0bf 0c1 0c4 0c8 0cb 0cc 0d3 0d4 0d5 0d6 0d9 0db 101 102 107 10d 10e 110 111 114 11c 11d 127 193 194 195 196 197 198 199 19a 19b 1bd 1c7 1cc 1cd 1ce 1cf 1d0 1d1 1d3 1d4 1d9 1da 1db'.split(
    ' ',
  )
// Capture holds 0 where the loader writes tile $25, past the level's end: not a difference in the level.
const PAST_END_ONLY = ['002', '102', '127']
const MARIO_DIFFERENT =
  '00a 011 095 096 097 098 099 09a 09b 0c0 0c2 0c3 0c6 0cc 0d0 0d2 0d5 0d7 0d8 0d9 102 109 10a 10f 115 116 119 120 123 12a 12c 130 195 196 197 198 199 19a 19b 1be 1bf 1c0 1c1 1c4 1c5 1c6 1c7 1ca 1d5'.split(
    ' ',
  )

describe.skipIf(!existsSync(TRACE_DIR) || !hasRom(VANILLA))(
  'level state vs Mesen: known-different sets (#649)',
  () => {
    it('Map16: the maps that differ from the capture are exactly the pinned set', () => {
      const r = map16Differences(freshRom())
      expect(r.total).toBe(154)
      expect(r.diff).toEqual(MAP16_DIFFERENT)
      expect(r.diff.length).toBe(66)
      expect(r.capturedZeroOnly).toEqual(PAST_END_ONLY)
    }, 300_000)

    it('Mario start: the table-read ($94/$96) differs from the capture on exactly the pinned maps', () => {
      const r = marioDifferences(freshRom())
      expect(r.compared).toBe(98)
      expect(r.diff).toEqual(MARIO_DIFFERENT)
      expect(r.diff.length).toBe(49)
    }, 300_000)

    it('both sweeps go red on a planted defect', () => {
      // The Mario table: moving X slot 0 changes every map that reads it, so the set must grow.
      const rom = freshRom()
      const before = marioDifferences(rom).diff
      rom.writeAt(0x05d750, [0x55])
      expect(marioDifferences(rom).diff.length).toBeGreaterThan(before.length)
      // The comparator itself: one flipped byte in a capture must register as a difference.
      const lo = Buffer.alloc(4, 7)
      const wram = new Uint8Array(0x30000)
      wram.fill(7, 0xc800, 0xc804)
      expect(tablesDiffer(lo, Buffer.alloc(0), wram)).toBe(false)
      lo[2] = 8
      expect(tablesDiffer(lo, Buffer.alloc(0), wram)).toBe(true)
    })
  },
)
