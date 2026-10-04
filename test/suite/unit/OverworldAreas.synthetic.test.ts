import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { deriveOverworldAreas, type OverworldAreaSet } from '../../../src/rom/OverworldAreas'

// Routine bytes as the vanilla ROM holds them (SMWDisX bank_00.asm:4250-4333;
// bank_04.asm:527-581, :1753-1774, :2356-2361, :2835-2885). '??' is an operand the
// module reads or ignores. Kept apart from the module's patterns on purpose.
const HEX = {
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
// SNES addresses; `moves` sites follow the routine bank.
const WHERE: Record<Name, { at: number; moves?: true }> = {
  camera: { at: 0x00a130 },
  scan: { at: 0x048509, moves: true },
  dest: { at: 0x04853b, moves: true },
  path: { at: 0x049a24, moves: true },
  jsl: { at: 0x00a08a },
  jsrPath: { at: 0x049616, moves: true },
  jsrStar: { at: 0x049161, moves: true },
  jsrPipe: { at: 0x049184, moves: true },
}
// Operand offsets inside the routines above.
const OP = {
  pathCounter: 18,
  pathLdy: 23,
  pathSrc: 44,
  pathDst: 67,
  warpLdy: 16,
  warpSrc: 18,
  warpDst: 12,
}
const T = { warpSrc: 0x8431, warpDst: 0x849d, pathSrc: 0x9968, pathDst: 0x99ae }

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

// Table cells, also used to plant mutations after `stub()` builds the vanilla ROM.
const warpSrc = (rom: RomFile, i: number, area: number, bank = 4): void =>
  rom.writeAt(inBank(T.warpSrc + 2 * i, bank), [0x10, area])
const warpDst = (rom: RomFile, i: number, area: number, bank = 4): void =>
  rom.writeAt(inBank(T.warpDst + 2 * i, bank), [0x10, area << 1])
const pathSrc = (rom: RomFile, i: number, area: number, bank = 4): void =>
  rom.writeAt(inBank(T.pathSrc + 5 * i, bank), [area])
const pathDst = (rom: RomFile, i: number, area: number, bank = 4): void =>
  rom.writeAt(inBank(T.pathDst + 5 * i, bank), [area])
const setByte = (rom: RomFile, n: Name, index: number, v: number): void =>
  rom.writeAt(siteAt(n) + index, [v])
const setWord = (rom: RomFile, n: Name, index: number, v: number): void =>
  rom.writeAt(siteAt(n) + index, [v & 0xff, v >> 8])

/** A 256 KB LoROM stub with vanilla-shaped routines, callers and tables planted from HEX. */
function stub(bank = 4): RomFile {
  const rom = new RomFile('stub.sfc', Buffer.alloc(0x40000))
  const put = (n: Name, ops: Record<number, number> = {}): void => {
    const b = tokens(HEX[n]).map(t => (t === '??' ? 0 : parseInt(t, 16)))
    for (const [i, v] of Object.entries(ops)) b[Number(i)] = v
    rom.writeAt(siteAt(n, bank), b)
  }
  const word = (base: number, v: number): Record<number, number> => ({
    [base]: v & 0xff,
    [base + 1]: v >> 8,
  })
  const low = (n: Name): number => siteAt(n, bank) & 0xffff
  put('camera', { ...word(5, 0xa06b), ...word(12, 0xa079) })
  put('scan', { [OP.warpLdy]: (WARP_SRC.length - 1) * 2, ...word(OP.warpSrc, T.warpSrc) })
  put('dest', word(OP.warpDst, T.warpDst))
  put('path', {
    [OP.pathCounter]: (PATH_SRC.length - 1) * 2,
    [OP.pathLdy]: (PATH_SRC.length - 1) * 5,
    ...word(OP.pathSrc, T.pathSrc),
    ...word(OP.pathDst, T.pathDst),
  })
  put('jsl', { ...word(6, low('dest')), 8: bank })
  put('jsrPath', word(7, low('path')))
  put('jsrStar', word(5, low('scan')))
  put('jsrPipe', word(5, low('scan')))
  WARP_SRC.forEach((a, i) => warpSrc(rom, i, a, bank))
  WARP_DST.forEach((a, i) => warpDst(rom, i, a, bank))
  PATH_SRC.forEach((a, i) => pathSrc(rom, i, a, bank))
  PATH_DST.forEach((a, i) => pathDst(rom, i, a, bank))
  return rom
}

const areasOf = (r: OverworldAreaSet): number[] => ('areas' in r ? r.areas.map(a => a.area) : [])
const invalidOf = (r: OverworldAreaSet): number[] =>
  'areas' in r ? r.areas.filter(a => a.invalid).map(a => a.area) : []
const refusal = (r: OverworldAreaSet): string => ('unavailable' in r ? r.unavailable : '')
const ALL = [0, 1, 2, 3, 4, 5, 6]
const derive = deriveOverworldAreas

describe('deriveOverworldAreas, synthetic ROMs (no corpus needed)', () => {
  it('vanilla-shaped bytes give areas 0-6, all valid', () => {
    const r = derive(stub())
    expect(areasOf(r)).toEqual(ALL)
    expect(invalidOf(r)).toEqual([])
  })

  it('an area named by a warp destination is listed, invalid past the camera table', () => {
    const rom = stub()
    warpDst(rom, 26, 7)
    const r = derive(rom)
    expect(areasOf(r)).toEqual([...ALL, 7])
    expect(invalidOf(r)).toEqual([7])
    expect((r as { areas: { invalid?: string }[] }).areas[7]!.invalid).toMatch(/7 entries/)
  })

  it('warp record 0 counts', () => {
    const rom = stub()
    warpDst(rom, 0, 7)
    expect(areasOf(derive(rom))).toEqual([...ALL, 7])
  })

  it('a warp destination is read in full (bits 9-12, mask $F)', () => {
    const rom = stub()
    warpDst(rom, 26, 8)
    expect(areasOf(derive(rom))).toEqual([...ALL, 8])
  })

  it('warp and path source areas are listed too', () => {
    const rom = stub()
    warpSrc(rom, 3, 9)
    pathSrc(rom, 3, 10)
    expect(areasOf(derive(rom))).toEqual([...ALL, 9, 10])
  })

  it('a path destination is listed, even from an area no record leads to', () => {
    const rom = stub()
    pathSrc(rom, 0, 8)
    pathDst(rom, 0, 12)
    expect(areasOf(derive(rom))).toEqual([...ALL, 8, 12])
  })

  it('the hub is listed even when no record names it', () => {
    const rom = stub()
    setByte(rom, 'path', OP.pathLdy, 0)
    setByte(rom, 'path', OP.pathCounter, 0)
    setByte(rom, 'scan', OP.warpLdy, 0)
    pathSrc(rom, 0, 3)
    pathDst(rom, 0, 4)
    warpSrc(rom, 0, 2)
    warpDst(rom, 0, 5)
    expect(areasOf(derive(rom))).toEqual([0, 2, 3, 4, 5])
  })

  it('the camera table length comes from the operands: a shorter one invalidates more areas', () => {
    const rom = stub()
    setWord(rom, 'camera', 12, 0xa06b + 8)
    const r = derive(rom)
    expect(areasOf(r)).toEqual(ALL)
    expect(invalidOf(r)).toEqual([4, 5, 6])
  })

  it('refuses an odd or backwards camera distance, or a camera operand outside the bank', () => {
    for (const [index, v] of [
      [12, 0xa06b + 9],
      [12, 0xa06b],
      [5, 0x7000],
    ] as const) {
      const rom = stub()
      setWord(rom, 'camera', index, v)
      expect(derive(rom), `${index} ${v}`).toHaveProperty('unavailable')
    }
  })

  it('the path record count follows the LDY and counter operands', () => {
    const rom = stub()
    pathDst(rom, 13, 11) // the last of 14 records
    expect(areasOf(derive(rom))).toEqual([...ALL, 11])
    setByte(rom, 'path', OP.pathLdy, 60)
    setByte(rom, 'path', OP.pathCounter, 24)
    expect(areasOf(derive(rom))).toEqual(ALL)
  })

  it('the warp record count follows the LDY operand', () => {
    const rom = stub()
    warpDst(rom, 26, 7)
    setByte(rom, 'scan', OP.warpLdy, 0x32) // drops warp 26 (offset $34)
    expect(areasOf(derive(rom))).toEqual(ALL)
  })

  it('refuses counts that disagree, are not strides, or exit the BPL loop after one pass', () => {
    const bad: [Name, number, number][] = [
      ['path', OP.pathLdy, 60], // counter still 26
      ['path', OP.pathCounter, 24], // LDY still 65
      ['path', OP.pathLdy, 64],
      ['scan', OP.warpLdy, 53],
      ['scan', OP.warpLdy, 0x82],
      ['path', OP.pathLdy, 0x87],
    ]
    for (const [n, index, v] of bad) {
      const rom = stub()
      setByte(rom, n, index, v)
      expect(derive(rom), `${n} ${v}`).toHaveProperty('unavailable')
    }
    const rom = stub()
    setByte(rom, 'scan', OP.warpLdy, 0x80)
    expect(derive(rom)).toHaveProperty('areas')
    setByte(rom, 'path', OP.pathLdy, 0x7d)
    setByte(rom, 'path', OP.pathCounter, 0x32)
    expect(derive(rom)).toHaveProperty('areas')
  })

  it('reads the tables from the bank the routines sit in', () => {
    const rom = stub(5)
    warpDst(rom, 26, 7, 5)
    expect(areasOf(derive(rom))).toEqual([...ALL, 7])
  })

  it('refuses when a caller does not call the site its routine was found at', () => {
    for (const [n, index] of [
      ['jsl', 6],
      ['jsrPath', 7],
      ['jsrStar', 5],
      ['jsrPipe', 5],
    ] as const) {
      const rom = stub()
      rom.writeAt(siteAt(n) + index, [rom.readByte(siteAt(n) + index)! + 1])
      expect(refusal(derive(rom)), n).toMatch(/does not call/)
    }
  })

  it('refuses a caller operand below $8000', () => {
    const rom = stub()
    setWord(rom, 'jsrPath', 7, 0x1a24)
    expect(refusal(derive(rom))).toMatch(/does not call/)
  })

  it('refuses a JSL caller with the right low word and another bank', () => {
    const rom = stub()
    setByte(rom, 'jsl', 8, 5)
    expect(refusal(derive(rom))).toMatch(/does not call/)
  })

  it('refuses table operands outside the bank, and one that runs a byte past it', () => {
    const operands: [Name, number][] = [
      ['scan', OP.warpSrc],
      ['dest', OP.warpDst],
      ['path', OP.pathSrc],
      ['path', OP.pathDst],
    ]
    for (const [n, index] of operands) {
      for (const v of [0x7000, 0xfff0]) {
        const rom = stub()
        setWord(rom, n, index, v)
        expect(derive(rom), `${n}+${index} ${v}`).toHaveProperty('unavailable')
      }
    }
    // The path source table is 66 bytes: $FFBE ends on the last byte of the bank.
    const rom = stub()
    setWord(rom, 'path', OP.pathSrc, 0xffbe)
    expect(derive(rom)).toHaveProperty('areas')
    setWord(rom, 'path', OP.pathSrc, 0xffbf)
    expect(derive(rom)).toHaveProperty('unavailable')
  })

  it('a missing site refuses with its own reason, before any caller is judged', () => {
    const rom = stub()
    setByte(rom, 'scan', 0, 0x00)
    expect(refusal(derive(rom))).toMatch(/CODE_048509, the warp scan .* is not stock/)
  })

  it('refuses a site that appears twice, so which copy runs is unknown', () => {
    for (const n of Object.keys(HEX) as Name[]) {
      const rom = stub()
      rom.writeAt(0x078000, rom.readAt(siteAt(n), tokens(HEX[n]).length)!)
      expect(derive(rom), n).toHaveProperty('unavailable')
    }
  })

  it('every pinned byte of every routine and caller, flipped, refuses', () => {
    const rom = stub()
    let flipped = 0
    for (const n of Object.keys(HEX) as Name[]) {
      tokens(HEX[n]).forEach((t, i) => {
        if (t === '??') return
        const at = siteAt(n) + i
        const was = rom.readByte(at)!
        rom.writeAt(at, [was ^ 0xff])
        expect(derive(rom), `${n}+${i}`).toHaveProperty('unavailable')
        rom.writeAt(at, [was])
        flipped++
      })
    }
    expect(derive(rom)).toHaveProperty('areas') // restored in full
    expect(flipped).toBe(
      Object.values(HEX)
        .flatMap(tokens)
        .filter(t => t !== '??').length,
    )
  })

  it('the refusal names the routine address', () => {
    const rom = stub()
    setByte(rom, 'path', 0, 0x00)
    expect(refusal(derive(rom))).toMatch(/049A24/)
  })
})
