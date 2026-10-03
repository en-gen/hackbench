import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { deriveOverworldAreas } from '../../../src/rom/OverworldAreas'

// Routine bytes as the vanilla ROM holds them (SMWDisX bank_01.asm:13940-13946,
// bank_04.asm:509-583, :2835-2897). '??' is an operand the module reads or ignores.
const PSWITCH = 'bd 64 15 c9 ?? d0 0c 8d 11 1f 8d b8 1f 9e c8 14 ee 26 14 60'
const WARP_SCAN =
  'ac b3 0d b9 11 1f 85 01 64 00 c2 20 ae d6 0d a0 ?? b9 ?? ?? 45 00 c9 00 02 b0 0d dd 1f 1f ' +
  'd0 08 bd 21 1f d9 ?? ?? f0 04 88 88 10 e5 8c f6 1d'
const WARP_DEST =
  '8b 4b ab c2 20 ae d6 0d ac f6 1d b9 ?? ?? 48 29 ff 01 9d 17 1f 4a 4a 4a 4a 9d 1f 1f b9 ?? ?? ' +
  '9d 19 1f 4a 4a 4a 4a 9d 21 1f 68 4a eb 29 0f 00 8d c3 13'
const PATH_SCAN =
  'c2 20 ad d6 0d 4a 4a aa bd 11 1f 29 ff 00 8d c3 13 a9 ?? 00 85 02 a0 ?? ae d6 0d bd 19 1f ' +
  'd9 ?? ?? d0 3e bd 17 1f d9 ?? ?? d0 36 b9 ?? ?? 29 ff 00 cd c3 13 d0 2b b9 ?? ?? 9d 19 1f ' +
  'b9 ?? ?? 9d 17 1f b9 ?? ?? 29 ff 00 8d c3 13 a4 02 b9 ?? ?? 29 ff 00 9d 21 1f b9 ?? ?? ' +
  '29 ff 00 9d 1f 1f 80 0b c6 02 c6 02 88 88 88 88 88 10 af e2 20'

const SITES = { pswitch: 0x01e75b, scan: 0x048509, dest: 0x04853b, path: 0x049a24 }
const T = { warpSrc: 0x048431, warpDst: 0x04849d, pathSrc: 0x049964, pathDst: 0x0499aa }

const tokens = (s: string): string[] => s.split(' ')
const bytes = (s: string): number[] => tokens(s).map(t => (t === '??' ? 0 : parseInt(t, 16)))

// Per-entry areas read from the vanilla ROM: the high byte of DATA_048431,
// bits 9-12 of DATA_04849D, and the area byte of each 5-byte path record.
// prettier-ignore
const WARP_SRC = [0, 0, 0, 0, 0, 0, 0, 2, 2, 4, 4, 4, 4, 6, 2, 6, 0, 6, 0, 6, 0, 6, 6, 5, 5, 4, 1]
// prettier-ignore
const WARP_DST = [2, 2, 4, 4, 4, 4, 6, 0, 0, 0, 0, 0, 0, 0, 6, 2, 6, 0, 6, 0, 6, 4, 5, 6, 1, 6, 6]
const PATH_SRC = [0, 0, 1, 1, 0, 2, 4, 0, 0, 3, 0, 3, 0, 3]
const PATH_DST = [1, 1, 0, 0, 2, 0, 0, 4, 3, 0, 3, 0, 3, 0]
const ALL = [0, 1, 2, 3, 4, 5, 6]

interface Opts {
  entry?: number
  warpDst?: number[]
  pathSrc?: number[]
  pathDst?: number[]
  /** Operands of LDY (path), the counter, and LDY (warp); default to what the arrays imply. */
  pathY?: number
  counter?: number
  warpY?: number
}

/** A 512 KB LoROM stub with vanilla-shaped routines and tables, planted from the hex above. */
function stub(o: Opts = {}): RomFile {
  const rom = new RomFile('stub.sfc', Buffer.alloc(0x80000))
  const pathSrc = o.pathSrc ?? PATH_SRC
  const pathDst = o.pathDst ?? PATH_DST
  const warpDst = o.warpDst ?? WARP_DST
  const put = (at: number, hex: string, operands: Record<number, number>): void => {
    const b = bytes(hex)
    for (const [i, v] of Object.entries(operands)) b[Number(i)] = v
    rom.writeAt(at, b)
  }
  const lo = (v: number): number => v & 0xff
  const hi = (v: number): number => v >> 8
  put(SITES.pswitch, PSWITCH, { 4: o.entry ?? 1 })
  put(SITES.scan, WARP_SCAN, {
    16: o.warpY ?? (WARP_SRC.length - 1) * 2,
    18: lo(T.warpSrc),
    19: hi(T.warpSrc),
  })
  put(SITES.dest, WARP_DEST, { 12: lo(T.warpDst), 13: hi(T.warpDst) })
  put(SITES.path, PATH_SCAN, {
    18: o.counter ?? (pathSrc.length - 1) * 2,
    23: o.pathY ?? (pathSrc.length - 1) * 5,
    44: lo(T.pathSrc + 4),
    45: hi(T.pathSrc + 4),
    67: lo(T.pathDst + 4),
    68: hi(T.pathDst + 4),
  })
  WARP_SRC.forEach((a, i) => rom.writeAt(T.warpSrc + 2 * i, [0x10, a]))
  warpDst.forEach((a, i) => rom.writeAt(T.warpDst + 2 * i, [0x10, a << 1]))
  pathSrc.forEach((a, i) => rom.writeAt(T.pathSrc + 4 + 5 * i, [a]))
  pathDst.forEach((a, i) => rom.writeAt(T.pathDst + 4 + 5 * i, [a]))
  return rom
}

describe('deriveOverworldAreas, synthetic ROMs (no corpus needed)', () => {
  it('vanilla-shaped bytes give entry 1 and areas 0-6', () => {
    expect(deriveOverworldAreas(stub())).toEqual({ entry: 1, areas: ALL })
  })

  it('a warp destination changed to an unused area adds it', () => {
    const dst = [...WARP_DST]
    dst[26] = 7 // the warp out of area 1, which is reached
    expect(deriveOverworldAreas(stub({ warpDst: dst }))).toEqual({ entry: 1, areas: [...ALL, 7] })
  })

  it('a path-transition destination changed to an unused area adds it', () => {
    const dst = [...PATH_DST]
    dst[0] = 9 // out of area 0, which is reached
    expect(deriveOverworldAreas(stub({ pathDst: dst }))).toEqual({ entry: 1, areas: [...ALL, 9] })
  })

  it('an edge out of an area nobody reaches adds nothing', () => {
    const src = [...PATH_SRC]
    const dst = [...PATH_DST]
    src[0] = 8
    dst[0] = 12
    expect(deriveOverworldAreas(stub({ pathSrc: src, pathDst: dst }))).toEqual({
      entry: 1,
      areas: ALL,
    })
  })

  it('the entry is the CMP immediate', () => {
    expect(deriveOverworldAreas(stub({ entry: 5 }))).toEqual({ entry: 5, areas: ALL })
  })

  it('the path entry count follows the LDY and counter operands', () => {
    const dst = [...PATH_DST]
    dst[13] = 11 // the last of 14 records, out of area 3
    expect(deriveOverworldAreas(stub({ pathDst: dst }))).toMatchObject({ areas: [...ALL, 11] })
    expect(deriveOverworldAreas(stub({ pathDst: dst, pathY: 60, counter: 24 }))).toMatchObject({
      areas: ALL,
    })
  })

  it('the warp entry count follows the LDY operand', () => {
    const dst = [...WARP_DST]
    dst[26] = 7
    // LDY #$32 drops warp 26 (offset $34)
    expect(deriveOverworldAreas(stub({ warpDst: dst, warpY: 0x32 }))).toMatchObject({ areas: ALL })
  })

  it('refuses when the path counts disagree, or a count is not a stride', () => {
    for (const o of [{ pathY: 60 }, { counter: 24 }, { pathY: 64, counter: 26 }, { warpY: 53 }]) {
      expect(deriveOverworldAreas(stub(o)), JSON.stringify(o)).toHaveProperty('unavailable')
    }
  })

  it('every pinned byte of every routine, flipped, refuses', () => {
    const routines: [number, string][] = [
      [SITES.pswitch, PSWITCH],
      [SITES.scan, WARP_SCAN],
      [SITES.dest, WARP_DEST],
      [SITES.path, PATH_SCAN],
    ]
    let flipped = 0
    for (const [at, hex] of routines) {
      tokens(hex).forEach((t, i) => {
        if (t === '??') return
        const rom = stub()
        rom.writeAt(at + i, [rom.readByte(at + i)! ^ 0xff])
        expect(deriveOverworldAreas(rom), `${at.toString(16)}+${i}`).toHaveProperty('unavailable')
        flipped++
      })
    }
    expect(flipped).toBeGreaterThan(190)
  })

  it('the refusal names the routine address', () => {
    const rom = stub()
    rom.writeAt(SITES.path, [0x00])
    expect(deriveOverworldAreas(rom)).toEqual({ unavailable: expect.stringMatching(/049A24/) })
  })

  it('an empty ROM refuses rather than listing seven areas', () => {
    const r = deriveOverworldAreas(new RomFile('x.sfc', Buffer.alloc(0x80000)))
    expect(r).toHaveProperty('unavailable')
  })
})
