/**
 * #860 review: the entrance-position readers (F400/F600, FA00/FC00 through DATA_05D708/D70C) are the
 * game's only while the level-start code reading them is stock (SubmapFlagGate LEVEL_START_Y). A hack
 * that rewrites that code and keeps the screen-exit graph intact is still drawn, said to be
 * unverified. No ROM: the "stock" build is the synthetic cart's own bytes, fingerprinted here; the
 * corpus block at the end runs the real fingerprints on the vanilla and Lunar Magic carts.
 */
import { describe, it, expect, vi } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { ADDR, SmwRom, type MapEntrances } from '../../../src/rom/SmwRom'
import {
  LEVEL_START_Y,
  entrancePositionGate,
  spanFingerprint,
  type StockCode,
  type StockSpan,
} from '../../../src/rom/SubmapFlagGate'
import { WILD } from '../../../src/rom/BytePattern'
import { readMapEntrances } from '../../../src/rom/ReadMapEntrances'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'
import { buildMapPayload, buildMapWithGraph } from '../../../src/rom/model/MapBuilder'
import { buildGraph } from '../../../src/rom/model/rehydrate'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { MAGIC, VANILLA, freshRom, hasRom } from '../support/corpus'
import { modeTablesRom, STANDARD, withLayer3 } from '../support/l3Rom'
import {
  plantOverworldTiles,
  plantStockSubmapCode,
  SYNTHETIC_FINGERPRINTS,
} from '../support/syntheticRom'

vi.mock('../../../src/rom/ObjectExpander', async orig => ({ ...(await orig<object>()), expandMap: () => [] })) // prettier-ignore
vi.mock('../../../src/rom/model/tiles/TileFactory', async orig => ({ ...(await orig<object>()), buildTiles: () => new Map() })) // prettier-ignore
vi.mock('../../../src/rom/model/L2Factory', async orig => ({ ...(await orig<object>()), buildBgTiles: () => new Map() })) // prettier-ignore

const MAP = 5
const ONLY_SECONDARY: MapEntrances = { overworld: false, primary: false, secondary: [0x1c3] }
const SPANS = LEVEL_START_Y.filter((c): c is StockSpan => 'fingerprints' in c)
const CODES = LEVEL_START_Y.filter((c): c is StockCode => 'bytes' in c)
const hex6 = (n: number) => `$${n.toString(16).toUpperCase().padStart(6, '0')}`

/**
 * Written from bank_05.asm, not from the constants under test, so a wrong constant goes red with no
 * ROM. The secondary-exit head, bank_05.asm:7111-7119: LDA UseSecondaryExit ($1B93) / BEQ to the JMP
 * at $05D83B (+$62) / REP #$30 / LDA #$0000 / SEP #$20 / LDY _E / LDA DATA_05F800,Y / STA _E /
 * STA LoadingLevelNumber ($17BB).
 */
const SECONDARY_HEAD_AT = 0x05d7d4
// prettier-ignore
const SECONDARY_HEAD = [
  0xad, 0x93, 0x1b, 0xf0, 0x62, 0xc2, 0x30, 0xa9, 0x00, 0x00, 0xe2, 0x20, 0xa4, 0x0e,
  0xb9, 0x00, 0xf8, 0x85, 0x0e, 0x8d, 0xbb, 0x17,
]
/** bank_05.asm:7265-7267: REP #$10 / SEP #$20 / LDY _E, the index of every F000..F600 read below. */
const MAIN_INDEX_AT = 0x05d907
const MAIN_INDEX = [0xc2, 0x10, 0xe2, 0x20, 0xa4, 0x0e]

/** Every code byte of the gate gets a distinct non-zero value, so any single flip changes a hash. */
function withStockCode(rom: RomFile): RomFile {
  for (const c of CODES)
    rom.writeAt(
      c.addr,
      c.bytes.map(b => (b === WILD ? 0 : b)),
    )
  for (const s of SPANS) rom.writeAt(s.addr, Array.from({ length: s.length }, (_, i) => (i % 250) + 1)) // prettier-ignore
  rom.writeAt(SECONDARY_HEAD_AT, SECONDARY_HEAD)
  rom.writeAt(MAIN_INDEX_AT, MAIN_INDEX)
  return rom
}
/** The spans as the synthetic cart's own build: stands in for the vanilla fingerprints. */
const stockOf = (rom: RomFile) =>
  LEVEL_START_Y.map(c =>
    'fingerprints' in c
      ? { ...c, fingerprints: [spanFingerprint(rom.readAt(c.addr, c.length))!] }
      : c,
  )
const flipAt = (rom: RomFile, at: number) => rom.writeAt(at, [rom.readByte(at)! ^ 0xff])

const header = parseLevelHeader(Uint8Array.from([0, 0, 0, 0, 0]))
const l1 = { header, isVertical: false, colors: [] } as never
const verdict = (rom: RomFile, spans: ReturnType<typeof stockOf>) =>
  buildL3Verdict(rom, MAP, l1, { ok: true, mode: 1 }, () => [[]] as never, { ok: true }, undefined, ONLY_SECONDARY, spans) // prettier-ignore
const l3Cart = () =>
  withStockCode(withLayer3(modeTablesRom([STANDARD, ...Array(31).fill(STANDARD)]), { level: MAP, tileset: 0, setting: 2, settingsByte: 0x02, word: 2 })) // prettier-ignore

describe('the layer 3 camera is unverified when the entrance-position code is not stock', () => {
  it('stock bytes: drawn, no reason', () => {
    const rom = l3Cart()
    const v = verdict(rom, stockOf(rom))
    expect(v.l3).not.toBeNull()
    expect(v.l3?.camYReasons).toBeUndefined()
  })

  // Every byte of every checked range, not a sample: a flip at any offset must name its own range.
  it.each(SPANS.map(s => [s.what, hex6(s.addr), s] as const))(
    'every byte of %s (span %s) changed in turn: still drawn, reason names the span',
    (_what, _addr, s) => {
      const rom = l3Cart()
      const spans = stockOf(rom)
      for (let off = 0; off < s.length; off++) {
        flipAt(rom, s.addr + off)
        const v = verdict(rom, spans)
        expect(v.l3, `offset ${off}`).not.toBeNull() // best effort, never blanked
        expect(v.l3?.camYPx).toBeDefined()
        expect(v.l3?.camYReasons?.[0]?.startsWith(`${hex6(s.addr)} `), `offset ${off}`).toBe(true)
        flipAt(rom, s.addr + off)
      }
    },
  )

  it.each(CODES.map(c => [c.what, hex6(c.addr), c] as const))(
    'every literal byte of %s (%s) changed in turn: the gate fires on it',
    (_what, _addr, c) => {
      const rom = l3Cart()
      const spans = stockOf(rom)
      let flipped = 0
      c.bytes.forEach((b, off) => {
        if (b === WILD) return
        flipAt(rom, c.addr + off)
        expect(verdict(rom, spans).l3?.camYReasons?.[0]?.startsWith(`${hex6(c.addr)} `), `offset ${off}`).toBe(true) // prettier-ignore
        flipAt(rom, c.addr + off)
        flipped++
      })
      expect(flipped).toBeGreaterThan(0)
    },
  )
})

/**
 * The instructions that read the position tables, at addresses worked out from bank_05.asm by
 * hand (instruction sizes summed from each label), not from LEVEL_START_Y: a range that moved or
 * shrank off one of them leaves it unwatched. The third field is the opcode it opens with.
 */
const POSITION_READS: readonly (readonly [string, number, number, string])[] = [
  ['LDA DATA_05FA00,Y', 0x05d7ea, 0xb9, 'bank_05.asm:7120'],
  ['STA Layer1YPos (secondary)', 0x05d80b, 0x85, 'bank_05.asm:7136'],
  ['LDA DATA_05FC00,Y', 0x05d81c, 0xb9, 'bank_05.asm:7147'],
  ['LDA DATA_05F400,Y', 0x05d981, 0xb9, 'bank_05.asm:7323'],
  ['STA Layer1YPos (main)', 0x05d99a, 0x85, 'bank_05.asm:7335'],
  ['LDA DATA_05F600,Y', 0x05d99c, 0xb9, 'bank_05.asm:7336'],
  ['AND #$1F', 0x05d9f0, 0x29, 'bank_05.asm:7377'],
  ['STA Layer1YPos+1', 0x05da05, 0x85, 'bank_05.asm:7388'],
]
const READS = POSITION_READS.map(([what, at, , cite]) => [what, hex6(at), at, cite] as const)

describe('the gate watches each instruction that reads the entrance position tables', () => {
  it.each(READS)('%s at %s (%s): flipping its opcode fires the gate', (_what, _addr, at) => {
    const rom = l3Cart()
    const spans = stockOf(rom)
    expect(entrancePositionGate(rom, spans)).toBeNull()
    flipAt(rom, at)
    expect(entrancePositionGate(rom, spans)).not.toBeNull()
  })

  it.each(READS)('%s at %s (%s): flipping its operand fires the gate', (_what, _addr, at) => {
    const rom = l3Cart()
    const spans = stockOf(rom)
    flipAt(rom, at + 1)
    expect(entrancePositionGate(rom, spans)).not.toBeNull()
  })

  // The control-flow gaps the first version left (#860 review): the branch around the
  // secondary-exit position reads, and the index every F000..F600 read goes through.
  it('stock: the independent encodings of the secondary-exit head and the index pass the gate', () => {
    const rom = l3Cart()
    expect(entrancePositionGate(rom, stockOf(rom))).toBeNull()
  })
  it('BEQ to BRA over the secondary-exit reads fires the gate (bank_05.asm:7112)', () => {
    const rom = l3Cart()
    const spans = stockOf(rom)
    expect(rom.readByte(0x05d7d7)).toBe(0xf0)
    rom.writeAt(0x05d7d7, [0x80])
    expect(entrancePositionGate(rom, spans)).toMatch(/^\$05D7D4 /)
  })
  it('a different operand on LDY _E fires the gate (bank_05.asm:7267)', () => {
    const rom = l3Cart()
    const spans = stockOf(rom)
    expect(rom.readByte(0x05d90c)).toBe(0x0e)
    rom.writeAt(0x05d90c, [0x0f])
    expect(entrancePositionGate(rom, spans)).toMatch(/^\$05D907 /)
  })
})

describe('the exit graph stays intact while the position routine changes', () => {
  function graphCart() {
    const buf = Buffer.alloc(0x400000, 0)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('graph.sfc', buf)
    plantStockSubmapCode(rom)
    plantOverworldTiles(rom)
    withStockCode(rom)
    const l1Ptr = (map: number, at: number) => rom.writeAt(ADDR.LEVEL_L1_PTR + map * 3, [at & 0xff, (at >> 8) & 0xff, at >> 16]) // prettier-ignore
    l1Ptr(0x105, 0x068000) // a submap root: its exits index the $1xx half
    rom.writeAt(0x068000, [0, 0, 0, 0, 0, 0x00, 0x02, 0x00, 0x10, 0x01, 0x02, 0x00, 0x11, 0xff])
    l1Ptr(0x177, 0x06b000)
    rom.writeAt(0x06b000, [0, 0, 0, 0, 0, 0x42, 0xff])
    rom.writeAt(ADDR.SEC_EXIT_DEST + 0x110, [0x77, 0x77])
    return rom
  }
  // The graph's own fingerprints, over this cart's own bytes where the position code overlaps them.
  const fingerprintsOf = (rom: RomFile) => ({
    ...SYNTHETIC_FINGERPRINTS,
    startExit: [spanFingerprint(rom.readAt(0x05d7d4, 103))!],
    startMain: [spanFingerprint(rom.readAt(0x05d938, 223))!],
  })

  it('LDY _E changed: the gate fires, readMapEntrances still returns the stock graph', () => {
    const rom = graphCart()
    const smw = new SmwRom(rom)
    const spans = stockOf(rom)
    const fp = fingerprintsOf(rom)
    const stock = readMapEntrances(smw, fp)
    expect(stock).toBeDefined()
    expect(stock!.get(0x177)).toEqual({ overworld: false, primary: false, secondary: [0x110, 0x111], route: 0x110 }) // prettier-ignore
    expect(entrancePositionGate(rom, spans)).toBeNull()

    rom.writeAt(0x05d90c, [0x0f]) // outside every span the graph checks
    expect(entrancePositionGate(rom, spans)).toMatch(/^\$05D907 /)
    const after = readMapEntrances(smw, fp)
    expect(after).not.toBeNull()
    expect(after).toEqual(stock)
  })
})

describe('MapBuilder carries the same reason on its map store, through the payload', () => {
  const LEVEL = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0xff])
  function blank(): RomFile {
    const real = RomFile.fromBytes('blank.sfc', Buffer.alloc(0x100000))
    real.writeAt(0x00ffd5, [0x20])
    return real
  }
  function cartOf(real: RomFile): SmwRom {
    const rom = new SmwRom(real)
    return Object.assign(Object.create(rom), { rom: real, getLevelRawData: () => LEVEL, requireVerticalTable: () => [] }) as SmwRom // prettier-ignore
  }
  const roundTrip = (rom: SmwRom, startSpans: ReturnType<typeof stockOf>) =>
    buildGraph(JSON.parse(JSON.stringify(buildMapPayload(rom, 7, { startSpans }))))

  it('a blank cart has no stock level-start code: the camera is drawn and unverified', () => {
    const { map } = buildMapWithGraph(cartOf(blank()), 7)
    expect(map.mapStore.entranceUnverified).toMatch(/^\$0096F4 /)
  })

  it('stock bytes: no reason, before and after the payload', () => {
    const real = withStockCode(blank())
    const rom = cartOf(real)
    const spans = stockOf(real)
    expect(buildMapWithGraph(rom, 7, { startSpans: spans }).map.mapStore.entranceUnverified).toBeUndefined() // prettier-ignore
    expect(roundTrip(rom, spans).map.mapStore.entranceUnverified).toBeUndefined()
  })

  it('one span byte changed: the reason names the span and survives serialize and rehydrate', () => {
    const real = withStockCode(blank())
    const rom = cartOf(real)
    const spans = stockOf(real)
    flipAt(real, 0x05d7ed)
    const built = buildMapWithGraph(rom, 7, { startSpans: spans }).map.mapStore.entranceUnverified
    expect(built).toMatch(/^\$05D7EA /)
    expect(buildMapPayload(rom, 7, { startSpans: spans }).header.entranceUnverified).toBe(built)
    expect(roundTrip(rom, spans).map.mapStore.entranceUnverified).toBe(built)
  })
})

describe.each([VANILLA, MAGIC])('the real fingerprints, %s', name => {
  it.skipIf(!hasRom(name))('the stock level-start code passes the gate: no map is flagged', () => {
    expect(entrancePositionGate(freshRom(name))).toBeNull()
  })

  // Addresses by hand (above): the opcode there must be the one named, then any flip must fire.
  it.skipIf(!hasRom(name))('each position read is where the ASM says, and watched', () => {
    for (const [what, at, op] of POSITION_READS) {
      const rom = freshRom(name)
      expect(rom.readByte(at), what).toBe(op)
      flipAt(rom, at)
      expect(entrancePositionGate(rom), what).not.toBeNull()
    }
  })
})
