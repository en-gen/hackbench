import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  CODE,
  LEN,
  NAMES,
  OP,
  SYNTHETIC_AREA_FPS,
  PATH_SRC,
  T,
  WARP_SRC,
  inBank,
  pathDst,
  pathSrc,
  plant,
  setByte,
  setWord,
  siteAt,
  stub,
  warpDst,
  warpSrc,
  word,
  type Name,
} from '../support/syntheticAreas'
import {
  AREA_SPANS,
  deriveOverworldAreas as derive,
  type OverworldAreaSet,
} from '../../../src/rom/OverworldAreas'

// Every call recognizes the planted stand-ins; the cart's own fingerprints are not these.
const deriveOverworldAreas = (rom: RomFile): OverworldAreaSet => derive(rom, SYNTHETIC_AREA_FPS)

const areasOf = (r: OverworldAreaSet): number[] => ('areas' in r ? r.areas.map(a => a.area) : [])
const invalidOf = (r: OverworldAreaSet): number[] =>
  'areas' in r ? r.areas.filter(a => a.invalid).map(a => a.area) : []
const refusal = (r: OverworldAreaSet): string => ('unavailable' in r ? r.unavailable : '')
const ALL = [0, 1, 2, 3, 4, 5, 6]
const low4 = (n: Name): number => siteAt(n) & 0xffff

describe('deriveOverworldAreas, synthetic ROMs (no corpus needed)', () => {
  it('vanilla-shaped bytes give areas 0-6, all valid', () => {
    const r = deriveOverworldAreas(stub())
    expect(areasOf(r)).toEqual(ALL)
    expect(invalidOf(r)).toEqual([])
  })

  it('an area named by a warp destination is listed, invalid past the camera table', () => {
    const rom = stub()
    warpDst(rom, 26, 7)
    const r = deriveOverworldAreas(rom)
    expect(areasOf(r)).toEqual([...ALL, 7])
    expect(invalidOf(r)).toEqual([7])
    expect((r as { areas: { invalid?: string }[] }).areas[7]!.invalid).toMatch(/7 entries/)
  })

  it('warp record 0 counts', () => {
    const rom = stub()
    warpDst(rom, 0, 7)
    expect(areasOf(deriveOverworldAreas(rom))).toEqual([...ALL, 7])
  })

  it('reads the signed camera X and Y from its own table cell', () => {
    const rom = stub()
    // Distinct words per table and area, so an unsigned read or an X/Y swap cannot match.
    const cams = [
      [0, 0],
      [-17, 296],
      [240, -40],
      [-1, 128],
      [32767, -32768],
      [5, 6],
      [-300, 7],
    ] as const
    cams.forEach(([x, y], i) => {
      rom.writeAt(0xa06b + 2 * i, [x & 0xff, (x >> 8) & 0xff])
      rom.writeAt(0xa079 + 2 * i, [y & 0xff, (y >> 8) & 0xff])
    })
    const r = deriveOverworldAreas(rom) as {
      areas: { area: number; cameraX?: number; cameraY?: number }[]
    }
    expect(r.areas.map(a => [a.area, a.cameraX, a.cameraY])).toEqual(
      cams.map(([x, y], i) => [i, x, y]),
    )
  })

  it('an invalid area carries no camera position', () => {
    const rom = stub()
    warpDst(rom, 26, 9)
    const r = deriveOverworldAreas(rom) as { areas: { area: number; cameraX?: number }[] }
    expect(r.areas.find(a => a.area === 9)).not.toHaveProperty('cameraX')
  })

  it('a warp destination is read in full (bits 9-12, mask $F)', () => {
    const rom = stub()
    warpDst(rom, 26, 8)
    expect(areasOf(deriveOverworldAreas(rom))).toEqual([...ALL, 8])
  })

  it('a record whose source is outside the camera table is dead and adds nothing', () => {
    const rom = stub()
    warpSrc(rom, 3, 9)
    warpDst(rom, 3, 12)
    pathSrc(rom, 3, 10)
    pathDst(rom, 3, 11)
    expect(areasOf(deriveOverworldAreas(rom))).toEqual(ALL)
  })

  it('LM-filled $FF records add nothing', () => {
    const rom = stub()
    for (let i = 0; i < WARP_SRC.length; i++) {
      warpSrc(rom, i, 0xff)
      rom.writeAt(inBank(T.warpDst + 2 * i, 4), [0xff, 0xff])
    }
    for (let i = 0; i < PATH_SRC.length; i++) {
      pathSrc(rom, i, 0xff)
      pathDst(rom, i, 0xff)
    }
    expect(areasOf(deriveOverworldAreas(rom))).toEqual([0])
  })

  it('a live record to area 9 gives an invalid row naming the first such record', () => {
    const rom = stub()
    warpDst(rom, 4, 9)
    warpDst(rom, 6, 9)
    pathDst(rom, 2, 9)
    const rows = (deriveOverworldAreas(rom) as { areas: { area: number; invalid?: string }[] })
      .areas
    expect(rows.find(r => r.area === 9)!.invalid).toMatch(
      /path record 2 leads to area 9, past the camera table's 7 entries/,
    )
    const rom2 = stub()
    warpDst(rom2, 4, 9)
    warpDst(rom2, 6, 9)
    const rows2 = (deriveOverworldAreas(rom2) as { areas: { area: number; invalid?: string }[] })
      .areas
    expect(rows2.find(r => r.area === 9)!.invalid).toMatch(/warp record 4 leads to area 9/)
  })

  it('a warp destination word of $FFFF at a live record is area 15 (bits 9-12)', () => {
    const rom = stub()
    rom.writeAt(inBank(T.warpDst + 2 * 26, 4), [0xff, 0xff])
    const areas = areasOf(deriveOverworldAreas(rom))
    expect(areas).toContain(15)
    expect(areas).not.toContain(127)
  })

  it('an area of $80 or more is invalid even inside a long camera table: the index wraps', () => {
    const rom = stub()
    setWord(rom, 'camera', 12, 0xa06b + 0x120) // 144 entries
    pathDst(rom, 13, 0x83) // record 13 is live: its source is area 3
    pathSrc(rom, 12, 0x84) // a source of $84 is dead
    pathDst(rom, 12, 0x85)
    const r = deriveOverworldAreas(rom) as { areas: { area: number; invalid?: string }[] }
    expect(r.areas.map(a => a.area)).toEqual([...ALL, 0x83])
    expect(r.areas.find(a => a.area === 0x83)!.invalid).toMatch(/path record 13 .*wraps/)
  })

  it('a JSL to the $84 mirror of CODE_04853B is the same call', () => {
    const rom = stub()
    setByte(rom, 'jsl', 8, 0x84)
    expect(areasOf(deriveOverworldAreas(rom))).toEqual(ALL)
  })

  it('reads the warp destination table from the bank CODE_04853B sits in', () => {
    const rom = stub()
    rom.writeAt(siteAt('dest'), Buffer.alloc(LEN('dest'))) // gone from bank 4
    plant(rom, 'dest', 5, word(OP.warpDst, T.warpDst))
    plant(rom, 'jsl', 4, { ...word(6, 0x853b), 8: 5 })
    warpDst(rom, 26, 7, 5) // only the bank 5 table has it
    expect(areasOf(deriveOverworldAreas(rom))).toContain(7)
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
    expect(areasOf(deriveOverworldAreas(rom))).toEqual([0, 2, 3, 4, 5])
  })

  it('the camera table length comes from the operands: a shorter one invalidates more areas', () => {
    const rom = stub()
    setWord(rom, 'camera', 12, 0xa06b + 8) // 4 entries
    const r = deriveOverworldAreas(rom)
    // Area 5 is only named by records out of area 6, which are dead.
    expect(invalidOf(r)).toEqual([4, 6])
    expect(areasOf(r)).toEqual([0, 1, 2, 3, 4, 6])
  })

  it('refuses a camera operand below $8000 even at an even distance', () => {
    const rom = stub()
    setWord(rom, 'camera', 5, 0x7001)
    setWord(rom, 'camera', 12, 0x700f)
    expect(deriveOverworldAreas(rom)).toHaveProperty('unavailable')
  })

  it('refuses a camera Y table that runs past the end of its bank', () => {
    const rom = stub()
    setWord(rom, 'camera', 12, 0xfff1) // even distance from $A06B, but Y + count*2 > $10000
    expect(deriveOverworldAreas(rom)).toHaveProperty('unavailable')
  })

  it('refuses an odd or backwards camera distance, or a camera operand outside the bank', () => {
    for (const [index, v] of [
      [12, 0xa06b + 9],
      [12, 0xa06b],
      [5, 0x7000],
    ] as const) {
      const rom = stub()
      setWord(rom, 'camera', index, v)
      expect(deriveOverworldAreas(rom), `${index} ${v}`).toHaveProperty('unavailable')
    }
  })

  it('the path record count follows the LDY and counter operands', () => {
    const rom = stub()
    pathDst(rom, 13, 11) // the last of 14 records
    expect(areasOf(deriveOverworldAreas(rom))).toEqual([...ALL, 11])
    setByte(rom, 'path', OP.pathLdy, 60)
    setByte(rom, 'path', OP.pathCounter, 24)
    expect(areasOf(deriveOverworldAreas(rom))).toEqual(ALL)
  })

  it('the warp record count follows the LDY operand', () => {
    const rom = stub()
    warpDst(rom, 26, 7)
    setByte(rom, 'scan', OP.warpLdy, 0x32) // drops warp 26 (offset $34)
    expect(areasOf(deriveOverworldAreas(rom))).toEqual(ALL)
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
      expect(deriveOverworldAreas(rom), `${n} ${v}`).toHaveProperty('unavailable')
    }
    const rom = stub()
    setByte(rom, 'scan', OP.warpLdy, 0x80)
    expect(deriveOverworldAreas(rom)).toHaveProperty('areas')
    setByte(rom, 'path', OP.pathLdy, 0x7d)
    setByte(rom, 'path', OP.pathCounter, 0x32)
    expect(deriveOverworldAreas(rom)).toHaveProperty('areas')
  })

  it('reads the tables from the bank the routines sit in', () => {
    const rom = stub(5)
    warpDst(rom, 26, 7, 5)
    expect(areasOf(deriveOverworldAreas(rom))).toEqual([...ALL, 7])
  })

  it('refuses a caller that does not call the site its routine was found at', () => {
    const cases: [string, (rom: RomFile) => void][] = [
      ['jsl low byte', r => setByte(r, 'jsl', 6, r.readByte(siteAt('jsl') + 6)! + 1)],
      ['jsrPath low byte', r => setByte(r, 'jsrPath', 7, r.readByte(siteAt('jsrPath') + 7)! + 1)],
      ['jsrStar low byte', r => setByte(r, 'jsrStar', 5, r.readByte(siteAt('jsrStar') + 5)! + 1)],
      ['jsrPipe low byte', r => setByte(r, 'jsrPipe', 5, r.readByte(siteAt('jsrPipe') + 5)! + 1)],
      ['jsrPath operand below $8000', r => setWord(r, 'jsrPath', 7, 0x1a24)],
      ['jsl right low word, bank 5', r => setByte(r, 'jsl', 8, 5)],
    ]
    for (const [label, mutate] of cases) {
      const rom = stub()
      mutate(rom)
      // A retargeted caller lands on a span that is not the routine, or on another routine.
      expect(refusal(deriveOverworldAreas(rom)), label).toMatch(
        /does not call|is not stock|that is not/,
      )
    }
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
        expect(deriveOverworldAreas(rom), `${n}+${index} ${v}`).toHaveProperty('unavailable')
      }
    }
    // The path source table is 66 bytes: $FFBE ends on the last byte of the bank.
    const rom = stub()
    setWord(rom, 'path', OP.pathSrc, 0xffbe)
    expect(deriveOverworldAreas(rom)).toHaveProperty('areas')
    setWord(rom, 'path', OP.pathSrc, 0xffbf)
    expect(deriveOverworldAreas(rom)).toHaveProperty('unavailable')
  })

  it('each span masks exactly its operand bytes, no opcode byte', () => {
    // Operand offsets read off the disassembly (see the module's SPANS): 16-bit table
    // addresses are two bytes, the counters and LDY immediates one. Over-masking an opcode
    // would let altered code hash as stock.
    const operands: Record<Name, number[]> = {
      camera: [5, 6, 12, 13],
      path: [18, 23, 31, 32, 39, 40, 44, 45, 55, 56, 61, 62, 67, 68, 78, 79, 87, 88],
      scan: [16, 18, 19, 36, 37],
      dest: [12, 13, 29, 30],
      jsl: [6, 7, 8],
      jsrPath: [7, 8],
      jsrStar: [5, 6],
      jsrPipe: [5, 6],
    }
    for (const n of NAMES) expect([...AREA_SPANS[n].mask], n).toEqual(operands[n])
  })

  it('a routine whose bytes are not the stock code refuses at the call that reaches it', () => {
    const rom = stub()
    setByte(rom, 'scan', 0, 0x00)
    expect(refusal(deriveOverworldAreas(rom))).toMatch(
      /calls code at file offset \w+ that is not CODE_048509, the warp scan/,
    )
  })

  it('refuses a camera read or a caller that appears twice, so which copy runs is unknown', () => {
    for (const n of ['camera', 'jsl', 'jsrPath', 'jsrStar', 'jsrPipe'] as Name[]) {
      const rom = stub()
      rom.writeAt(0x078000, rom.readAt(siteAt(n), LEN(n))!)
      expect(deriveOverworldAreas(rom), n).toHaveProperty('unavailable')
    }
  })

  it('a routine is where its callers call: a moved one resolves, a left-behind copy is ignored', () => {
    // Move CODE_048509 and CODE_049A24 within bank 4, retarget their callers and leave the
    // stock-place copies behind: the old whole-ROM scan saw two matches and refused.
    const rom = stub()
    const scanTo = inBank(0xb000, 4)
    const pathTo = inBank(0xb100, 4)
    rom.writeAt(scanTo, CODE.scan)
    rom.writeAt(scanTo + OP.warpLdy, [(WARP_SRC.length - 1) * 2])
    rom.writeAt(scanTo + OP.warpSrc, [T.warpSrc & 0xff, T.warpSrc >> 8])
    rom.writeAt(pathTo, CODE.path)
    rom.writeAt(pathTo + OP.pathCounter, [(PATH_SRC.length - 1) * 2])
    rom.writeAt(pathTo + OP.pathLdy, [(PATH_SRC.length - 1) * 5])
    rom.writeAt(pathTo + OP.pathSrc, [T.pathSrc & 0xff, T.pathSrc >> 8])
    rom.writeAt(pathTo + OP.pathDst, [T.pathDst & 0xff, T.pathDst >> 8])
    plant(rom, 'jsrStar', 4, word(5, 0xb000))
    plant(rom, 'jsrPipe', 4, word(5, 0xb000))
    plant(rom, 'jsrPath', 4, word(7, 0xb100))
    expect(areasOf(deriveOverworldAreas(rom))).toEqual(ALL)
    // The moved routines read tables of their own (all zeros: every record live, every path
    // destination area 0). The left-behind stock tables kill the records that would name the
    // new areas, so 7 and 8 appear only if the moved copy was the one read.
    const movedPathDst = inBank(0xb300, 4)
    rom.writeAt(scanTo + OP.warpSrc, [0x00, 0xb5])
    rom.writeAt(pathTo + OP.pathSrc, [0x00, 0xb2])
    rom.writeAt(pathTo + OP.pathDst, [0x00, 0xb3])
    warpSrc(rom, 26, 0xff)
    warpDst(rom, 26, 7)
    pathSrc(rom, 13, 0xff)
    rom.writeAt(movedPathDst + 5 * 13, [8])
    expect(areasOf(deriveOverworldAreas(rom))).toEqual([0, 1, 2, 4, 5, 6, 7, 8]) // 3 is gone: only the stock path table named it
    // Only one of the scan's two callers retargeted: they disagree about where it is.
    plant(rom, 'jsrPipe', 4, word(5, low4('scan')))
    expect(refusal(deriveOverworldAreas(rom))).toMatch(/does not call/)
  })

  it('a called routine whose code is altered refuses, naming it', () => {
    for (const [n, re] of [
      ['path', /CODE_049A24/],
      ['scan', /CODE_048509/],
      ['dest', /CODE_04853B/],
      ['camera', /camera read/],
    ] as const) {
      const rom = stub()
      const i = CODE[n].findIndex((b, k) => k > 1 && !AREA_SPANS[n].mask.includes(k) && b === 0xea)
      rom.writeAt(siteAt(n) + i, [0xea ^ 0x01])
      expect(refusal(deriveOverworldAreas(rom)), n).toMatch(re)
    }
  })

  it('every pinned byte of every routine and caller, flipped, refuses', () => {
    const rom = stub()
    let flipped = 0
    for (const n of NAMES) {
      for (let i = 0; i < LEN(n); i++) {
        if (AREA_SPANS[n].mask.includes(i)) continue
        const at = siteAt(n) + i
        const was = rom.readByte(at)!
        rom.writeAt(at, [was ^ 0xff])
        expect(deriveOverworldAreas(rom), `${n}+${i}`).toHaveProperty('unavailable')
        rom.writeAt(at, [was])
        flipped++
      }
    }
    expect(deriveOverworldAreas(rom)).toHaveProperty('areas') // restored in full
    expect(flipped).toBe(NAMES.reduce((t, n) => t + LEN(n) - AREA_SPANS[n].mask.length, 0))
  })

  it('refuses every span under the cart fingerprints: stand-ins are not the stock code', () => {
    expect(derive(stub())).toEqual({
      unavailable: expect.stringMatching(/camera read .* not stock/),
    })
  })

  it('the refusal names the routine address', () => {
    const rom = stub()
    setByte(rom, 'path', 0, 0x00)
    expect(refusal(deriveOverworldAreas(rom))).toMatch(/049A24/)
  })
})
