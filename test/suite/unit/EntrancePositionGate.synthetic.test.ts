/**
 * #860 review: the entrance-position readers (F400/F600, FA00/FC00 through DATA_05D708/D70C) are the
 * game's only while the level-start code reading them is stock (SubmapFlagGate LEVEL_START_Y). A hack
 * that rewrites that code and keeps the screen-exit graph intact is still drawn, said to be
 * unverified. No ROM: the "stock" build is the synthetic cart's own bytes, fingerprinted here.
 */
import { describe, it, expect, vi } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, type MapEntrances } from '../../../src/rom/SmwRom'
import { LEVEL_START_Y, spanFingerprint, type StockSpan } from '../../../src/rom/SubmapFlagGate'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'
import { buildMapWithGraph } from '../../../src/rom/model/MapBuilder'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { modeTablesRom, STANDARD, withLayer3 } from '../support/l3Rom'

vi.mock('../../../src/rom/ObjectExpander', async orig => ({ ...(await orig<object>()), expandMap: () => [] })) // prettier-ignore
vi.mock('../../../src/rom/model/tiles/TileFactory', async orig => ({ ...(await orig<object>()), buildTiles: () => new Map() })) // prettier-ignore
vi.mock('../../../src/rom/model/L2Factory', async orig => ({ ...(await orig<object>()), buildBgTiles: () => new Map() })) // prettier-ignore

const MAP = 5
const ONLY_SECONDARY: MapEntrances = { overworld: false, primary: false, secondary: [0x1c3] }
const SPANS = LEVEL_START_Y.filter((c): c is StockSpan => 'fingerprints' in c)

/** Every code byte of the gate gets a distinct non-zero value, so any single flip changes a hash. */
function withStockCode(rom: RomFile): RomFile {
  rom.writeAt(0x0096f4, [0x22, 0x96, 0xd7, 0x05]) // the REACH check
  for (const s of SPANS) rom.writeAt(s.addr, Array.from({ length: s.length }, (_, i) => (i % 250) + 1)) // prettier-ignore
  return rom
}
/** The spans as the synthetic cart's own build: stands in for the vanilla fingerprints. */
const stockOf = (rom: RomFile) =>
  LEVEL_START_Y.map(c =>
    'fingerprints' in c
      ? { ...c, fingerprints: [spanFingerprint(rom.readAt(c.addr, c.length))!] }
      : c,
  )

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
    expect(v.l3?.camYUnverified).toBeUndefined()
  })
  it.each(
    SPANS.flatMap(s => [0, 1, s.length >> 1, s.length - 1].map(o => [s.what, s.addr, o] as const)),
  )(
    'one byte changed in %s (span $%i, offset %i): still drawn, reason names the span',
    (_what, addr, off) => {
      const rom = l3Cart()
      const spans = stockOf(rom)
      rom.writeAt(addr + off, [rom.readByte(addr + off)! ^ 0xff]) // e.g. the opcode of a FA00/FC00 read, or a JSL hook
      const v = verdict(rom, spans)
      expect(v.l3).not.toBeNull() // best effort, never blanked
      expect(v.l3?.camYPx).toBeDefined()
      expect(v.l3?.camYUnverified?.startsWith(`$${addr.toString(16).toUpperCase().padStart(6, '0')} `)).toBe(true) // prettier-ignore
    },
  )
})

describe('MapBuilder carries the same reason on its map store', () => {
  const LEVEL = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0xff])
  function cart(): SmwRom {
    const real = RomFile.fromBytes('blank.sfc', Buffer.alloc(0x100000))
    real.writeAt(0x00ffd5, [0x20])
    const rom = new SmwRom(real)
    return Object.assign(Object.create(rom), { rom: real, getLevelRawData: () => LEVEL, requireVerticalTable: () => [] }) as SmwRom // prettier-ignore
  }
  it('a blank cart has no stock level-start code: the camera is drawn and unverified', () => {
    const { map } = buildMapWithGraph(cart(), 7)
    expect(map.mapStore.entranceUnverified).toMatch(/^\$0096F4 /)
  })
})
