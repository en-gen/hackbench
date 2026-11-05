/**
 * #1061 (M5, H1): two checks on the call-path gate and its stand-in.
 *  1. No ROM, runs in CI: ClusterPath.ts, CastleFlames.ts and RotatingRing.ts hold no stored byte array (rule 7 of
 *     FINGERPRINT MINIMUM allows single named constants). A pair of adjacent byte literals is the smallest array,
 *     so the probe's 8-byte window cannot be the only guard: every old literal was shorter than it.
 *  2. Needs the vanilla ROM: the assembled stand-in has no 5-byte window that is also a window of the ROM.
 *     Why 5: on the stand-in as first written (flipped to the invented code in this change), the count of
 *     matching windows by width was 8: 0, 6: 2 (the two known), 5: 7 (new ones were runs of 2-3 instructions of
 *     the loop head and the activate-flag store), 4: 16, 3: 32 (mostly operand coincidence in a 512 KB image).
 *     5 is the smallest width whose extra hits are still instruction runs. Evidence scope: one machine, the
 *     corpus VANILLA image, flat LoROM read, 3+ distinct values per window.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { clusterPathStandIn } from '../../support/clusterPathStandIn'
import { hasRom, romPath, VANILLA } from '../../support/corpus'
import { loadVanillaBytes, vanillaHits, windowSet } from '../../support/vanillaWindows'

const REPO = join(__dirname, '../../../..')
const GATE_FILES = [
  'src/rom/sprites/interp/CastleFlames.ts',
  'src/rom/sprites/interp/RotatingRing.ts',
  'src/rom/sprites/interp/ClusterPath.ts',
]

/**
 * Adjacent byte literals that are not ROM code, pinned per file as exact text and count: sprite ids (documented
 * constants), and WRAM states the gate plants (an invented marker pointer, Mario's position). A new array, or a
 * second copy of one, goes red.
 */
const NOT_CODE: Record<string, string[]> = {
  'src/rom/sprites/interp/RotatingRing.ts': ['0xe2, 0xe3', '0xf0, 0x7f', '0xf0, 0x7f'],
}

/** Two byte literals (or one and a `null` mask) in a row, comments aside: a stored byte array. */
export function byteArrays(text: string): string[] {
  const code = text.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '')
  return code.match(/\b0x[0-9a-f]{2}\b\s*,\s*(?:null|0x[0-9a-f]{2}\b)/gi) ?? []
}

/** The arrays of `text` beyond the pinned `allowed` ones (each allowed entry cancels one match). */
export function strayArrays(text: string, allowed: readonly string[] = []): string[] {
  const left = [...allowed]
  return byteArrays(text).filter(m => {
    const i = left.indexOf(m)
    if (i < 0) return true
    left.splice(i, 1)
    return false
  })
}

describe('no stored byte array in the gate sources (no ROM)', () => {
  it.each(GATE_FILES)('%s', file => {
    expect(strayArrays(readFileSync(join(REPO, file), 'utf8'), NOT_CODE[file])).toEqual([])
  })

  it('planted: an array of invented bytes, plain or masked, is flagged; named constants and comments are not', () => {
    expect(strayArrays('const want = [0x5a, 0xa5, 0x3c]')).toHaveLength(1)
    expect(strayArrays('{ at: 1, want: [0x11, null, 0x22] }')).toHaveLength(1)
    expect(
      strayArrays(
        ['const OP = 0x5a', 'const B = 0xa5 // 0x11, 0x22', '/* 0x33, 0x44 */'].join('\n'),
      ),
    ).toEqual([])
    expect(strayArrays('const span = [0x02a8c0, 0x02a8d0]')).toEqual([])
  })

  it('planted: a pinned array cancels once; a second copy is flagged', () => {
    const one = '[0x91, 0x42]'
    expect(strayArrays(one, ['0x91, 0x42'])).toEqual([])
    expect(strayArrays(`${one} ${one}`, ['0x91, 0x42'])).toHaveLength(1)
  })
})

const W = 5
/** Per written span of `entries`, the count of its 5-byte windows that are also vanilla windows (spans with none are left out). */
export function standInHits(entries: [number, number[]][], vanilla: ReadonlySet<string>): string[] {
  return entries.flatMap(([at, bytes]) => {
    const n = vanillaHits(Uint8Array.from(bytes), vanilla, W).length
    return n ? [`$${at.toString(16)} x${n}`] : []
  })
}

describe.skipIf(!hasRom(VANILLA))(
  'the cluster path stand-in holds no 5-byte vanilla window',
  () => {
    let cached: Set<string> | undefined
    const vanilla = () => (cached ??= windowSet(loadVanillaBytes(romPath(VANILLA)), W))

    it.each([false, true])('fastRom %s: 0 windows', fastRom => {
      expect(standInHits(clusterPathStandIn({ fastRom }), vanilla())).toEqual([])
    })

    it('planted: 5 vanilla bytes written as a stand-in span are flagged (it can fail)', () => {
      const v = loadVanillaBytes(romPath(VANILLA))
      const real = Array.from(v.subarray(0x12000, 0x12000 + W))
      expect(new Set(real).size).toBeGreaterThanOrEqual(3)
      expect(standInHits([[0x02f900, real]], vanilla())).toEqual(['$2f900 x1'])
    })
  },
)
