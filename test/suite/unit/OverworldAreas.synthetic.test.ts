import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { deriveOverworldAreas, type OverworldAreaSet } from '../../../src/rom/OverworldAreas'

// Routine bytes as the vanilla ROM holds them (SMWDisX bank_00.asm:3386-3392, :4250-4333;
// bank_01.asm:13939-13947; bank_04.asm:527-581, :1753-1774, :2356-2361, :2835-2885).
// '??' is an operand the module reads or ignores. `msgbox` is sprite $19's handler.
const HEX = {
  msgbox: 'bd 64 15 c9 ?? d0 0c 8d 11 1f 8d b8 1f 9e c8 14 ee 26 14 60',
  init: 'a2 15 bd ?? ?? 9d b8 1f ca 10 f7 60',
  intro: 'a9 ?? 8d 09 01 20 ?? ??',
  camera: '0a aa c2 20 bd ?? ?? 85 1a 85 1e bd ?? ?? 85 1c 85 20 e2 20',
  scan:
    'ac b3 0d b9 11 1f 85 01 64 00 c2 20 ae d6 0d a0 ?? b9 ?? ?? 45 00 c9 00 02 b0 0d dd 1f 1f ' +
    'd0 08 bd 21 1f d9 ?? ?? f0 04 88 88 10 e5 8c f6 1d',
  dest:
    '8b 4b ab c2 20 ae d6 0d ac f6 1d b9 ?? ?? 48 29 ff 01 9d 17 1f 4a 4a 4a 4a 9d 1f 1f b9 ?? ?? ' +
    '9d 19 1f 4a 4a 4a 4a 9d 21 1f 68 4a eb 29 0f 00 8d c3 13',
  path:
    'c2 20 ad d6 0d 4a 4a aa bd 11 1f 29 ff 00 8d c3 13 a9 ?? 00 85 02 a0 ?? ae d6 0d bd 19 1f ' +
    'd9 ?? ?? d0 3e bd 17 1f d9 ?? ?? d0 36 b9 ?? ?? 29 ff 00 cd c3 13 d0 2b b9 ?? ?? 9d 19 1f ' +
    'b9 ?? ?? 9d 17 1f b9 ?? ?? 29 ff 00 8d c3 13 a4 02 b9 ?? ?? 29 ff 00 9d 21 1f b9 ?? ?? ' +
    '29 ff 00 9d 1f 1f 80 0b c6 02 c6 02 88 88 88 88 88 10 af e2 20',
  jsl: 'ad 9c 1b f0 04 22 ?? ?? ?? 20 a6 a1',
  jsrPath: 'dd 26 94 d0 2a 5a 20 ?? ?? 7a a9 01',
  jsrStar: 'c9 5f d0 18 20 ?? ?? d0 2e 9c f7 1d',
  jsrPipe: 'c9 5b d0 11 20 ?? ?? d0 0b ee 9c 1b',
}
type Name = keyof typeof HEX
// SNES addresses; `moves` sites follow the routine bank option.
const WHERE: Record<Name, { at: number; moves?: true }> = {
  msgbox: { at: 0x01e75b },
  init: { at: 0x009f1d },
  intro: { at: 0x009cb0 },
  camera: { at: 0x00a130 },
  scan: { at: 0x048509, moves: true },
  dest: { at: 0x04853b, moves: true },
  path: { at: 0x049a24, moves: true },
  jsl: { at: 0x00a08a },
  jsrPath: { at: 0x049616, moves: true },
  jsrStar: { at: 0x049161, moves: true },
  jsrPipe: { at: 0x049184, moves: true },
}
// Sprite $19's entry in the sprite main pointer table (bank_01.asm:923).
const SPRITE_PTR = 0x0185cc + 0x19 * 2
const T = { warpSrc: 0x8431, warpDst: 0x849d, pathSrc: 0x9968, pathDst: 0x99ae, init: 0x9ef0 }

const tokens = (s: string): string[] => s.split(' ')
const inBank = (at: number, bank: number): number => (bank << 16) | (at & 0xffff)
const siteAt = (n: Name, bank = 4): number =>
  WHERE[n].moves ? inBank(WHERE[n].at, bank) : WHERE[n].at

// Areas read from the vanilla ROM: the high byte of DATA_048431, bits 9-12 of
// DATA_04849D, and the area byte of each 5-byte path record.
// prettier-ignore
const WARP_SRC = [0, 0, 0, 0, 0, 0, 0, 2, 2, 4, 4, 4, 4, 6, 2, 6, 0, 6, 0, 6, 0, 6, 6, 5, 5, 4, 1]
// prettier-ignore
const WARP_DST = [2, 2, 4, 4, 4, 4, 6, 0, 0, 0, 0, 0, 0, 0, 6, 2, 6, 0, 6, 0, 6, 4, 5, 6, 1, 6, 6]
const PATH_SRC = [0, 0, 1, 1, 0, 2, 4, 0, 0, 3, 0, 3, 0, 3]
const PATH_DST = [1, 1, 0, 0, 2, 0, 0, 4, 3, 0, 3, 0, 3, 0]

type OpKey = 'warpSrc' | 'warpDst' | 'pathSrc' | 'pathDst' | 'init' | 'camX' | 'camY'
interface Opts {
  /** InitPlayerOverworldData[0], and what the sprite $19 handler writes. */
  entry?: number
  writes?: number
  /** The intro's `LDA #imm`; 0 means the intro does not run. */
  intro?: number
  /** Sprite $19's pointer, when not the handler's own address. */
  spritePtr?: number
  /** The bank the warp and path routines, their callers and their tables sit in. */
  bank?: number
  warpDst?: number[]
  pathSrc?: number[]
  pathDst?: number[]
  pathY?: number
  counter?: number
  warpY?: number
  /** Table operands in place of the vanilla ones. */
  ops?: Partial<Record<OpKey, number>>
  /** Add 1 to the operand of this caller. */
  skew?: Name
}

/** A 512 KB LoROM stub with vanilla-shaped routines and tables, planted from HEX. */
function stub(o: Opts = {}): RomFile {
  const rom = new RomFile('stub.sfc', Buffer.alloc(0x80000))
  const bank = o.bank ?? 4
  const pathSrc = o.pathSrc ?? PATH_SRC
  const ops = {
    warpSrc: T.warpSrc,
    warpDst: T.warpDst,
    pathSrc: T.pathSrc,
    pathDst: T.pathDst,
    init: T.init,
    camX: 0xa06b,
    camY: 0xa079,
    ...o.ops,
  }
  const put = (n: Name, operands: Record<number, number> = {}): void => {
    const b = tokens(HEX[n]).map(t => (t === '??' ? 0 : parseInt(t, 16)))
    for (const [i, v] of Object.entries(operands)) b[Number(i)] = v
    rom.writeAt(siteAt(n, bank), b)
  }
  const word = (base: number, v: number): Record<number, number> => ({
    [base]: v & 0xff,
    [base + 1]: v >> 8,
  })
  const call = (n: Name, site: Name): number =>
    (siteAt(site, bank) & 0xffff) + (o.skew === n ? 1 : 0)

  put('msgbox', { 4: o.writes ?? 1 })
  put('init', word(3, ops.init))
  put('intro', { 1: o.intro ?? 0xe9, ...word(6, 0x9f06) })
  put('camera', { ...word(5, ops.camX), ...word(12, ops.camY) })
  put('scan', { 16: o.warpY ?? (WARP_SRC.length - 1) * 2, ...word(18, ops.warpSrc) })
  put('dest', word(12, ops.warpDst))
  put('path', {
    18: o.counter ?? (pathSrc.length - 1) * 2,
    23: o.pathY ?? (pathSrc.length - 1) * 5,
    ...word(44, ops.pathSrc),
    ...word(67, ops.pathDst),
  })
  put('jsl', { ...word(6, call('jsl', 'dest')), 8: bank })
  put('jsrPath', word(7, call('jsrPath', 'path')))
  put('jsrStar', word(5, call('jsrStar', 'scan')))
  put('jsrPipe', word(5, call('jsrPipe', 'scan')))
  const ptr = o.spritePtr ?? WHERE.msgbox.at & 0xffff
  rom.writeAt(SPRITE_PTR, [ptr & 0xff, ptr >> 8])
  rom.writeAt(inBank(T.init, 0), [o.entry ?? 1])
  const table = (base: number, stride: number, hi: (a: number) => number[], v: number[]): void =>
    v.forEach((a, i) => rom.writeAt(inBank(base + stride * i, bank), hi(a)))
  table(T.warpSrc, 2, a => [0x10, a], WARP_SRC)
  table(T.warpDst, 2, a => [0x10, a << 1], o.warpDst ?? WARP_DST)
  table(T.pathSrc, 5, a => [a], pathSrc)
  table(T.pathDst, 5, a => [a], o.pathDst ?? PATH_DST)
  return rom
}

const areasOf = (r: OverworldAreaSet): number[] => ('areas' in r ? r.areas.map(a => a.area) : [])
const invalidOf = (r: OverworldAreaSet): number[] =>
  'areas' in r ? r.areas.filter(a => a.invalid).map(a => a.area) : []
const refusal = (r: OverworldAreaSet): string => ('unavailable' in r ? r.unavailable : '')
const ALL = [0, 1, 2, 3, 4, 5, 6]
const run = (o: Opts): OverworldAreaSet => deriveOverworldAreas(stub(o))

describe('deriveOverworldAreas, synthetic ROMs (no corpus needed)', () => {
  it('vanilla-shaped bytes give entry 1 and areas 0-6, all valid', () => {
    const r = run({})
    expect(r).toMatchObject({ entry: 1 })
    expect(areasOf(r)).toEqual(ALL)
    expect(invalidOf(r)).toEqual([])
  })

  it('a warp destination changed to an unused area adds it, marked invalid past the camera table', () => {
    const dst = [...WARP_DST]
    dst[26] = 7 // the warp out of area 1, which is reached
    const r = run({ warpDst: dst })
    expect(areasOf(r)).toEqual([...ALL, 7])
    expect(invalidOf(r)).toEqual([7])
    expect((r as { areas: { invalid?: string }[] }).areas[7]!.invalid).toMatch(/7 entries/)
  })

  it('a warp to area 8 is read in full (bits 9-12, mask $F)', () => {
    const dst = [...WARP_DST]
    dst[26] = 8
    expect(areasOf(run({ warpDst: dst }))).toEqual([...ALL, 8])
  })

  it('a path-transition destination changed to an unused area adds it', () => {
    const dst = [...PATH_DST]
    dst[0] = 9 // out of area 0, which is reached
    expect(areasOf(run({ pathDst: dst }))).toEqual([...ALL, 9])
  })

  it('an edge out of an area nobody reaches adds nothing', () => {
    const src = [...PATH_SRC]
    const dst = [...PATH_DST]
    src[0] = 8
    dst[0] = 12
    expect(areasOf(run({ pathSrc: src, pathDst: dst }))).toEqual(ALL)
  })

  it('the search starts at the entry, so a one-way graph keeps only what it reaches', () => {
    // One path record 3 -> 4 and one warp 0 -> 2: from entry 3 only {3, 4} is reached.
    const r = run({ entry: 3, writes: 3, pathSrc: [3], pathDst: [4], warpY: 0 })
    expect(areasOf(r)).toEqual([3, 4])
  })

  it('the entry is InitPlayerOverworldData[0], agreeing with the intro start-area write', () => {
    expect(run({ entry: 5, writes: 5 })).toMatchObject({ entry: 5 })
  })

  it('refuses when the intro runs and the sprite $19 write names a different area', () => {
    expect(refusal(run({ writes: 2 }))).toMatch(/sprite \$19 handler writes area \$02/)
  })

  it('refuses when the intro runs and sprite $19 is not the recognized handler', () => {
    expect(refusal(run({ spritePtr: 0xe800 }))).toMatch(/not the code sprite \$19 runs/)
  })

  it('with the intro off, InitPlayerOverworldData alone decides, whatever the write holds', () => {
    expect(run({ intro: 0, writes: 2 })).toMatchObject({ entry: 1 })
    const rom = stub({ intro: 0 })
    rom.writeAt(WHERE.msgbox.at, [0x22]) // a JSL in place of the load: the write is not recognized
    expect(deriveOverworldAreas(rom)).toMatchObject({ entry: 1 })
  })

  it('the camera table length comes from the operands: a shorter one invalidates more areas', () => {
    const r = run({ ops: { camY: 0xa06b + 8 } })
    expect(areasOf(r)).toEqual(ALL)
    expect(invalidOf(r)).toEqual([4, 5, 6])
  })

  it('refuses an odd or backwards camera distance, or a camera operand outside the bank', () => {
    for (const ops of [{ camY: 0xa06b + 9 }, { camY: 0xa06b }, { camX: 0x7000 }]) {
      expect(run({ ops }), JSON.stringify(ops)).toHaveProperty('unavailable')
    }
  })

  it('the path entry count follows the LDY and counter operands', () => {
    const dst = [...PATH_DST]
    dst[13] = 11 // the last of 14 records, out of area 3
    expect(areasOf(run({ pathDst: dst }))).toEqual([...ALL, 11])
    expect(areasOf(run({ pathDst: dst, pathY: 60, counter: 24 }))).toEqual(ALL)
  })

  it('the warp entry count follows the LDY operand', () => {
    const dst = [...WARP_DST]
    dst[26] = 7
    expect(areasOf(run({ warpDst: dst, warpY: 0x32 }))).toEqual(ALL)
  })

  it('refuses when counts disagree, are not strides, or would exit the BPL loop after one pass', () => {
    const bad: Opts[] = [{ pathY: 60 }, { counter: 24 }, { pathY: 64, counter: 26 }, { warpY: 53 }]
    bad.push({ warpY: 0x82 }, { pathY: 0x87, counter: 0x6c })
    for (const o of bad) expect(run(o), JSON.stringify(o)).toHaveProperty('unavailable')
    // The largest counts the loops can walk are accepted.
    expect(run({ warpY: 0x80 })).toHaveProperty('areas')
    expect(run({ pathY: 0x7d, counter: 0x32 })).toHaveProperty('areas')
  })

  it('reads the tables from the bank the routines sit in', () => {
    const dst = [...WARP_DST]
    dst[26] = 7
    expect(areasOf(run({ bank: 5, warpDst: dst }))).toEqual([...ALL, 7])
  })

  it('refuses when a caller does not call the site its routine was found at', () => {
    for (const skew of ['jsl', 'jsrPath', 'jsrStar', 'jsrPipe'] as Name[]) {
      expect(refusal(run({ skew })), skew).toMatch(/does not call/)
    }
  })

  it('refuses every table operand that is not bank-local or runs past the bank', () => {
    for (const key of ['warpSrc', 'warpDst', 'pathSrc', 'pathDst', 'init'] as const) {
      for (const v of [0x7000, 0xfff0]) {
        expect(run({ ops: { [key]: v } }), `${key} ${v}`).toHaveProperty('unavailable')
      }
    }
  })

  it('refuses a site that appears twice, so which copy runs is unknown', () => {
    for (const n of Object.keys(HEX) as Name[]) {
      const rom = stub()
      rom.writeAt(0x0a8000, rom.readAt(siteAt(n), tokens(HEX[n]).length)!)
      expect(deriveOverworldAreas(rom), n).toHaveProperty('unavailable')
    }
  })

  it('every pinned byte of every routine and caller, flipped, refuses', () => {
    let flipped = 0
    for (const n of Object.keys(HEX) as Name[]) {
      tokens(HEX[n]).forEach((t, i) => {
        if (t === '??') return
        const rom = stub()
        const at = siteAt(n) + i
        rom.writeAt(at, [rom.readByte(at)! ^ 0xff])
        expect(deriveOverworldAreas(rom), `${n}+${i}`).toHaveProperty('unavailable')
        flipped++
      })
    }
    expect(flipped).toBe(
      Object.values(HEX)
        .flatMap(tokens)
        .filter(t => t !== '??').length,
    )
  })

  it('the refusal names the routine address', () => {
    const rom = stub()
    rom.writeAt(WHERE.path.at, [0x00])
    expect(refusal(deriveOverworldAreas(rom))).toMatch(/049A24/)
  })

  it('an empty ROM refuses rather than listing seven areas', () => {
    expect(deriveOverworldAreas(new RomFile('x.sfc', Buffer.alloc(0x80000)))).toHaveProperty(
      'unavailable',
    )
  })
})
