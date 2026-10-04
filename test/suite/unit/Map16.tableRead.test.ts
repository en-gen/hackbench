/**
 * Map16 pointer tables read from the ROM's own fill loops and operands
 * (#489). Synthetic stubs prove each refusal; the corpus pins stock output.
 */
import { createHash } from 'node:crypto'
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  loadMap16WithPipeVariants,
  readL2Map16Table,
  readMap16AppTable,
  readMap16Bank,
  readMap16Table,
  TILESET_COUNT,
  type Map16Read,
} from '../../../src/rom/Map16'
import { gateQuadrantWrite, sharedTileTest } from '../../../theia/extension/src/node/map16-decode'
import { buildTiles } from '../../../src/rom/model/tiles/TileFactory'
import { PipeVariantsBehavior } from '../../../src/rom/model/tiles/behaviors/PipeVariantsBehavior'
import {
  BANK00_SITES,
  BANK05_SITES,
  HOOK_LOW_AT,
  map16Stub,
  SITE_ADDR,
  WRAPPER_BRA,
  type Map16Code,
  type Map16Site,
} from '../support/syntheticMap16'
import { CORPUS, freshRom, hasRom, MAGIC, VANILLA } from '../support/corpus'

const stub = (code: Partial<Map16Code> = {}, omit: Map16Site[] = []): RomFile =>
  RomFile.fromBytes('stub.sfc', map16Stub(code, omit))
const HOOK = { bank: 0x0d, bound: 0x400 }

function valueOf<T>(r: Map16Read<T>): T {
  if (!r.ok) throw new Error(r.reason)
  return r.value
}
function reasonOf(r: Map16Read<unknown>): string {
  expect(r.ok).toBe(false)
  return r.ok ? '' : r.reason
}

describe('L2 (background) table (no ROM)', () => {
  it('takes base, stride, count and bank from the fill loop and its readers', () => {
    const code = { bgBase: 0xa000, bgStride: 0x10, bgBound: 0x200, bank: 0x0e }
    const bg = valueOf(readL2Map16Table(stub(code)))
    expect([bg.length, bg[0], bg[3]]).toEqual([256, 0x0ea000, 0x0ea030])
  })

  it('refuses a missing or duplicated fill loop, and a bound that is no pointer count', () => {
    expect(reasonOf(readL2Map16Table(stub({}, ['bgLoop'])))).toContain('fill loop')
    const rom = stub()
    rom.writeAt(0x05f000, [...rom.readAt(SITE_ADDR.bgLoop, 32)!])
    expect(reasonOf(readL2Map16Table(rom))).toContain('fill loop')
    expect(reasonOf(readL2Map16Table(stub({ bgBound: 0x401 })))).toContain('pointer count')
  })

  it('refuses a bound past the 512-entry Map16Pointers array, never clamps it', () => {
    expect(reasonOf(readL2Map16Table(stub({ bgBound: 0x402 })))).toContain('Map16Pointers')
    expect(reasonOf(readL2Map16Table(stub({ bgBound: 0xfffe })))).toContain('Map16Pointers')
    expect(reasonOf(readL2Map16Table(stub({ hook: HOOK, bgBound: 0x402 })))).toContain(
      'Map16Pointers',
    )
    expect(valueOf(readL2Map16Table(stub({ bgBound: 0x400 })))).toHaveLength(512)
  })

  it('refuses when no level-load JSR reaches the routine holding the loop', () => {
    expect(reasonOf(readL2Map16Table(stub({}, ['bgPath'])))).toContain('JSR')
    const rom = stub()
    rom.writeAt(0x058126, [0x60]) // target no longer opens with the PHP the loop's PLP closes
    expect(reasonOf(readL2Map16Table(rom))).toContain('JSR')
    const elsewhere = stub({}, ['bgPath']) // a JSR in another bank cannot reach the loop
    elsewhere.writeAt(0x048060, [0xa2, 0x00, 0xb9, 0x86, 0x0d, 0xc2, 0x20, 0x20, 0x26, 0x81])
    elsewhere.writeAt(0x048126, [0x08])
    expect(reasonOf(readL2Map16Table(elsewhere))).toContain('JSR')
  })

  it('follows an edit to the same RomFile rather than a cached scan', () => {
    const rom = stub()
    expect(valueOf(readL2Map16Table(rom))[0]).toBe(0x0d9100)
    rom.writeAt(SITE_ADDR.bgLoop + 3, [0x00, 0xa0])
    expect(valueOf(readL2Map16Table(rom))[0]).toBe(0x0da000)
  })

  it('refuses a background write the ROM does not locate, and writes where it does', () => {
    const write = (rom: RomFile) => gateQuadrantWrite(rom, 0, 'bg', 3, 'tr', 'charNum', 0x12)
    expect(write(stub({}, ['bgLoop'])).status).toBe('unavailable')
    const ok = write(stub({ bgBase: 0xa000 }))
    expect(ok.status === 'ok' && ok.write.romAddr).toBe(0x0da000 + 3 * 8 + 4)
    expect(write(stub({ bgBase: 0x0000 })).status).toBe('refused') // $0D001C is not ROM
  })
})

describe('the Map16 data bank (no ROM)', () => {
  it('refuses both layers when no level routine reads Map16Pointers', () => {
    const rom = stub({}, ['bank00', 'bank05'])
    expect(reasonOf(readL2Map16Table(rom))).toContain('Map16Pointers')
    expect(reasonOf(readMap16Table(rom, 0))).toContain('Map16Pointers')
  })

  it('refuses a level site whose read is neither stock nor the hook', () => {
    const rom = stub()
    rom.writeAt(BANK05_SITES[0]! + 15, [0x22, 0x00, 0x80, 0x06, 0x85, 0x0a])
    expect(reasonOf(readMap16Table(rom, 0))).toContain('neither stock nor')
  })

  it('refuses when readers disagree, including the credits reader', () => {
    const rom = stub()
    rom.writeAt(SITE_ADDR.credits + 1, [0x0e])
    expect(reasonOf(readL2Map16Table(rom))).toContain('disagree')
  })

  it('takes a hooked site bank from the hook and its extent from the CMP bound', () => {
    const rom = stub({ hook: { bank: 0x0e, bound: 0x200 } }, ['credits'])
    expect(valueOf(readMap16Bank(rom))).toEqual({ bank: 0x0e0000, extent: 256 })
    expect(valueOf(readMap16Table(rom, 0))).toHaveLength(256)
    expect(valueOf(readL2Map16Table(rom))).toHaveLength(256)
  })

  it('refuses a hook or wrapper that differs by one byte', () => {
    for (const at of [SITE_ADDR.hook + 0x15 + 19, SITE_ADDR.wrapper + 13]) {
      const rom = stub({ hook: HOOK })
      rom.writeAt(at, [0xea])
      expect(reasonOf(readMap16Table(rom, 0))).toContain('neither stock nor')
    }
  })
})

describe('L1 (foreground) table (no ROM)', () => {
  it('reads the CODE_058281 override from its operands', () => {
    const code = {
      slopeTileset: 3,
      slopeStarts: [0x100, 0x180] as [number, number],
      slopeSource: 0x9000,
      slopeLastIndex: 1,
      slopeStride: 0x10,
    }
    const t3 = valueOf(readMap16Table(stub(code), 3))
    expect([t3[0x100], t3[0x101], t3[0x180], t3[0x181]]).toEqual([
      0x0d9000, 0x0d9010, 0x0d9020, 0x0d9030,
    ])
    expect(t3[0x102]).not.toBe(0x0d9020)
    expect(valueOf(readMap16Table(stub(code), 0))[0x100]).toBe(0x0d9000)
    expect(valueOf(readMap16Table(stub(code), 7))[0x100]).not.toBe(0x0d9000)
  })

  it('refuses when the override block is missing or its branch no longer lands on it', () => {
    expect(reasonOf(readMap16Table(stub({}, ['slopes']), 5))).toContain('CODE_058281')
    const rom = stub()
    rom.writeAt(SITE_ADDR.slopes + 9, [0x06])
    expect(reasonOf(readMap16Table(rom, 5))).toContain('CODE_058281')
  })

  it('reads Map16Common, TilesetMAP16Loc and the bitmap from the setup operands', () => {
    const code = {
      commonBase: 0xa000,
      bitmapAddr: 0x05f900,
      tilesetTable: 0x05fa00,
      tilesetWord: 0xb000,
    }
    const rom = stub(code)
    rom.writeAt(0x05f900, [0x80])
    expect(valueOf(readMap16Table(rom, 2)).slice(0, 2)).toEqual([0x0da000, 0x0db000])
    expect(reasonOf(readMap16Table(stub({}, ['fgSetup']), 0))).toContain('CODE_0581FB')
    const far = stub()
    far.writeAt(SITE_ADDR.fgSetup + 33, [0x00, 0x80, 0x7d])
    expect(reasonOf(readMap16Table(far, 0))).toContain('TilesetMAP16Loc')
  })
})

describe('MAP16AppTable (no ROM)', () => {
  it('reads the table its LDA.L operands name', () => {
    const t = valueOf(readMap16AppTable(stub({ appTable: 0x05f800 })))
    expect(t).toEqual([0x0d8ab0, 0x0d84e0, 0x0d8af0, 0x0d8b30])
  })

  it('refuses when one reader is gone, the two disagree, or only one is jumped over', () => {
    expect(reasonOf(readMap16AppTable(stub({}, ['app'])))).toContain('MAP16AppTable')
    const rom = stub()
    rom.writeAt(SITE_ADDR.app + 15, [0x00, 0xf8])
    expect(reasonOf(readMap16AppTable(rom))).toContain('MAP16AppTable')
    const mixed = stub({ pipes: 'skipped' })
    mixed.writeAt(SITE_ADDR.app - 9, [0xe2, 0x30, 0xa5, 0x47, 0x4a, 0x4a, 0x4a, 0xc2, 0x30])
    expect(reasonOf(readMap16AppTable(mixed))).toContain('MAP16AppTable')
    const astray = stub({ pipes: 'skipped' }) // JMPs that land somewhere other than the exits
    for (const at of [0x0580c0, SITE_ADDR.app]) astray.writeAt(at - 6, [0x00, 0x90])
    expect(reasonOf(readMap16AppTable(astray))).toContain('MAP16AppTable')
  })

  it('reports no pipe cycle when both readers are jumped over', () => {
    const rom = stub({ pipes: 'skipped' })
    expect(valueOf(readMap16AppTable(rom))).toBeNull()
    expect(loadMap16WithPipeVariants(rom, 0).pipeVariants).toEqual([])
  })
})

describe('diverted and tampered read sites (no ROM)', () => {
  it('refuses when a stock bank setter is diverted outright', () => {
    for (const at of [BANK00_SITES[1]!, BANK05_SITES[2]!]) {
      const rom = stub()
      rom.writeAt(at, [0x5c, 0x00, 0x80, 0x0e]) // JML over the setter
      expect(reasonOf(readMap16Bank(rom))).toContain('bank setters')
    }
  })

  it('reads the bank through GPW 1.2 style BRA wrappers too', () => {
    const rom = stub({ hook: { ...HOOK, bank: 0x0e, wrapper: 'bra' } }, ['credits'])
    expect(valueOf(readMap16Bank(rom)).bank).toBe(0x0e0000)
  })

  it('refuses every single-byte change to a fixed byte of the hook or either wrapper', () => {
    // [hook, address, length, operand bytes that may vary]
    const cases: [NonNullable<Map16Code['hook']>, number, number, number[]][] = [
      [HOOK, SITE_ADDR.hook, 5, [1, 2, 4]],
      [HOOK, SITE_ADDR.hook + HOOK_LOW_AT, 23, [11, 16]],
      [HOOK, SITE_ADDR.wrapper, 20, [10, 11]],
      [{ ...HOOK, wrapper: 'bra' }, WRAPPER_BRA, 19, [10]],
    ]
    for (const [hook, at, length, operands] of cases) {
      for (let i = 0; i < length; i++) {
        if (operands.includes(i)) continue
        const rom = stub({ hook }, ['credits'])
        rom.writeAt(at + i, [rom.readAt(at + i, 1)![0]! ^ 0xff])
        expect(readMap16Bank(rom).ok, `$${at.toString(16)}+${i}`).toBe(false)
      }
    }
  })

  it('refuses a hook whose bound admits no tile, and keeps stock sites unbounded', () => {
    expect(readMap16Bank(stub({ hook: { ...HOOK, bound: 0 } })).ok).toBe(false)
    expect(JSON.parse(JSON.stringify(valueOf(readMap16Bank(stub()))))).toEqual({ bank: 0x0d0000 })
  })

  it('refuses an L1 (foreground) write past the hook extent though the count says 512', () => {
    const rom = stub({ hook: { ...HOOK, bound: 0x200 } })
    const gate = gateQuadrantWrite(rom, 0, 'fg', 300, 'tl', 'charNum', 1)
    expect(gate.status === 'refused' && gate.reason).toContain('256 tiles')
  })
})

describe('pipe cycle and shared tiles (no ROM)', () => {
  it('counts a JMP ahead of an intact lead-in as skipping the reader', () => {
    const rom = stub()
    for (const at of [0x0580c0, SITE_ADDR.app]) {
      const exit = (at & 0xffff) + 31
      rom.writeAt(at - 12, [0x4c, exit & 0xff, exit >> 8])
    }
    expect(valueOf(readMap16AppTable(rom))).toBeNull()
  })

  it('refuses the pipe table when the extent stops short of $133-$13A', () => {
    const rom = stub({ hook: { ...HOOK, bound: 0x200 } })
    expect(reasonOf(readMap16AppTable(rom))).toContain('extent')
  })

  it('leaves the pipe tiles static when the ROM has no pipe cycle', () => {
    const tiles = buildTiles(stub({ pipes: 'skipped' }), 0, new Map())
    expect(tiles.get(0x133)!.behavior).not.toBeInstanceOf(PipeVariantsBehavior)
  })

  it('marks L1 (foreground) tiles shared by the Map16Common run this ROM names', () => {
    const shared = sharedTileTest(stub({ commonBase: 0xa000 }), 'fg')
    expect([shared(0x0da000), shared(0x0da000 + 511 * 8), shared(0x0d8000)]).toEqual([
      true,
      true,
      false,
    ])
  })
})

/** sha256 over every pointer the level engine builds for this ROM. */
function tableDigest(rom: RomFile): string {
  const tables: (number[] | null)[] = []
  for (let t = 0; t < TILESET_COUNT; t++) tables.push(valueOf(readMap16Table(rom, t)))
  tables.push(valueOf(readL2Map16Table(rom)), valueOf(readMap16AppTable(rom)))
  return createHash('sha256').update(JSON.stringify(tables)).digest('hex')
}

// Digest of the tables develop@999592d built from constants, before #489.
const STOCK_DIGEST = 'bfae13f181bc6c6d8db4ebc6f1de8388cda1126d3eceb90f77ed081967933cba'

describe.skipIf(!hasRom(VANILLA) || !hasRom(MAGIC))('Map16 tables on stock ROMs (corpus)', () => {
  it('reads byte-identical tables to the pre-#489 constants', () => {
    expect(tableDigest(freshRom(VANILLA))).toBe(STOCK_DIGEST)
    expect(tableDigest(freshRom(MAGIC))).toBe(STOCK_DIGEST)
  })
})

describe.skipIf(!CORPUS.slice(2).every(hasRom))('Map16 tables on hacks (corpus)', () => {
  it('reads bank $0D through the hook on the four hacks, which do not cycle pipes', () => {
    for (const name of CORPUS.slice(2)) {
      const rom = freshRom(name)
      expect(valueOf(readMap16Bank(rom)), name).toEqual({ bank: 0x0d0000, extent: 512 })
      expect(valueOf(readL2Map16Table(rom))[0], name).toBe(0x0d9100)
      expect(valueOf(readMap16Table(rom, 0)), name).toHaveLength(512)
      expect(valueOf(readMap16AppTable(rom)), name).toBeNull()
    }
  })
})
