/**
 * #860: every caller of the entrance choice hands its map's `MapEntrances` down. No vanilla map is
 * entered only through secondary entrances, so the corpus cannot see a dropped `via`; these maps
 * are built here. Hand-written expected values, no ROM bytes. Each test goes red when its call
 * site stops passing `via`.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import * as L2LoaderReal from '../../../src/rom/L2Loader'
import type * as L2LoaderMod from '../../../src/rom/L2Loader'
import * as L3ModelReal from '../../../src/rom/model/L3Model'
import type * as L3ModelMod from '../../../src/rom/model/L3Model'
import { readInitialLayer1YPos, loadL3Tilemap } from '../../../src/rom/L3Loader'
import { readInitialLayer2YPos } from '../../../src/rom/L2Loader'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { buildL2 } from '../../../src/rom/model/L2Factory'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'
import { buildL3 } from '../../../src/rom/model/L3Factory'
import { buildMapInputs } from '../../../theia/extension/src/node/map-screen'
import { SmwRom, type MapEntrances } from '../../../src/rom/SmwRom'
import { modeTablesRom, STANDARD, withLayer3 } from '../support/l3Rom'
import { writeStockSkipChain } from '../support/skipChain'

vi.mock('../../../src/rom/L2Loader', async importOriginal => {
  const real = await importOriginal<typeof L2LoaderMod>()
  return { ...real, loadL2Objects: vi.fn(real.loadL2Objects) }
})
vi.mock('../../../src/rom/model/L3Model', async importOriginal => {
  const real = await importOriginal<typeof L3ModelMod>()
  return { ...real, buildL3Verdict: vi.fn(real.buildL3Verdict) }
})
afterEach(() => vi.mocked(L2LoaderReal.loadL2Objects).mockReset())

const L1_Y = [0x10, 0x60, 0xc0, 0x30]
const L2_Y = [0x08, 0x28, 0x48, 0x68]
const MAP = 5
const ENTRANCE = 0x1c3
/** Only this entrance enters the map: the old default (the primary row) and the secondary row differ. */
const ONLY_SECONDARY: MapEntrances = { overworld: false, primary: false, secondary: [ENTRANCE] }
const fa = (l1: number, l2: number) => (l2 << 6) | (l1 << 4)

function tables(rom: RomFile): RomFile {
  rom.writeAt(0x05d708, L1_Y)
  rom.writeAt(0x05d70c, L2_Y)
  rom.writeAt(0x05f400 + MAP, [(2 << 2) | 1]) // primary row: L1 index 2, L2 index 1
  rom.writeAt(0x05fa00 + ENTRANCE, [fa(1, 3)]) // secondary row: L1 index 1, L2 index 3
  return rom
}
const SECONDARY = { l1: L1_Y[1]!, l2: L2_Y[3]! }
const PRIMARY = { l1: L1_Y[2]!, l2: L2_Y[1]! }

describe('a map entered only through a secondary entrance (synthetic)', () => {
  it('buildL2 reads Layer2YPos from the secondary row', () => {
    const rom = tables(new RomFile('l2.sfc', Buffer.alloc(0x80000, 0)))
    rom.writeAt(0x05e600 + MAP * 3, [0x00, 0x90, 0x0c]) // an object-stream L2 pointer
    writeStockSkipChain(rom)
    vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid: [[1]] })
    const header = parseLevelHeader(Uint8Array.from([0, 1, 0, 0, 0]))
    const at = (via?: MapEntrances) => buildL2(rom, MAP, header, 1, false, new Map(), new Map(), new Map(), null, 0, new Array<number>(32).fill(0), via) as unknown as { initialLayer2YPx: number } // prettier-ignore
    expect(at(ONLY_SECONDARY).initialLayer2YPx).toBe(SECONDARY.l2)
    expect(at(undefined).initialLayer2YPx).toBe(PRIMARY.l2) // control: no graph reads the primary row
  })

  const l3Rom = (settingsByte: number) =>
    withLayer3(tables(modeTablesRom([STANDARD, ...Array(31).fill(STANDARD)])), { level: MAP, tileset: 0, setting: 2, settingsByte, word: 0x0002 }) // prettier-ignore
  const header = parseLevelHeader(Uint8Array.from([0, 0, 0, 0, 0]))
  const l1 = { header, isVertical: false, colors: [] } as never
  const sheets = () => [[]] as never

  it('buildL3Verdict reports the camera from the secondary row', () => {
    const at = (via?: MapEntrances) => buildL3Verdict(l3Rom(0x02), MAP, l1, { ok: true, mode: 1 }, sheets, { ok: true }, undefined, via).l3?.camYPx // prettier-ignore
    expect(at(ONLY_SECONDARY)).toBe(SECONDARY.l1)
    expect(at(undefined)).toBe(PRIMARY.l1)
  })

  it('loadL3Tilemap: a camera-locked $81 byte and the camera come from the same entrance', () => {
    const r = l3Rom(0x81)
    const load = loadL3Tilemap(r, MAP, 0, 0, ONLY_SECONDARY)
    expect(load?.initialCameraYPx).toBe(SECONDARY.l1)
    expect(load?.initialYPx).toBe(SECONDARY.l1) // settings $81 off tilesets 1 and 3: Layer3YPos = Layer1YPos
    expect(loadL3Tilemap(r, MAP, 0, 0)?.initialYPx).toBe(PRIMARY.l1) // control
  })

  it('buildL3 (the reference build) places a camera-locked layer 3 from the secondary row', () => {
    const at = (via?: MapEntrances) =>
      buildL3(l3Rom(0x81), MAP, 0, sheets(), 1, false, 0, via)?.initialYPx
    expect(at(ONLY_SECONDARY)).toBe(SECONDARY.l1)
    expect(at(undefined)).toBe(PRIMARY.l1)
  })

  it("the Theia build hands the map's entrances to the layer 3 verdict", () => {
    const raw = tables(new RomFile('x.sfc', Buffer.alloc(0x80000, 0)))
    raw.writeAt(0x00ffd5, [0x20]) // LoROM, which SmwRom checks
    const rom = new SmwRom(raw)
    const inputs = { header, isVertical: false, colors: [], screenCount: 1 }
    const spy = vi.mocked(L3ModelReal.buildL3Verdict)
    spy.mockClear()
    const flags = { green: false, yellow: false, blue: false, red: false }
    buildMapInputs(rom, MAP, flags, () => ({ ok: true, mode: 1 }), () => ({ ok: true, inputs }) as never, () => new Map([[MAP, ONLY_SECONDARY]])) // prettier-ignore
    expect(spy.mock.calls.at(-1)?.[7]).toBe(ONLY_SECONDARY)
  })
})

describe('vertical maps: the high byte follows the chosen entrance', () => {
  const VMAP = 0x105
  function world(): RomFile {
    const r = new RomFile('v.sfc', Buffer.alloc(0x400000, 0))
    r.writeAt(0x05d708, L1_Y)
    r.writeAt(0x05d70c, L2_Y)
    r.writeAt(0x05f600 + VMAP, [0x22]) // bit 5: vertical; the primary high byte is $02
    r.writeAt(0x05fa00 + ENTRANCE, [0xd0]) // L1 index 1 ($60), L2 index 3 ($68)
    r.writeAt(0x05fc00 + ENTRANCE, [0x05]) // the secondary entrance's own high byte
    return r
  }
  it('a secondary-only map takes DATA_05FC00[entrance] & $1F, not DATA_05F600', () => {
    expect(readInitialLayer1YPos(world(), VMAP, true, ONLY_SECONDARY)).toBe(0x560)
    expect(readInitialLayer2YPos(world(), VMAP, true, ONLY_SECONDARY)).toBe(0x568)
  })
  it('a primary entry keeps DATA_05F600 & $1F', () => {
    const via: MapEntrances = { overworld: true, primary: false, secondary: [ENTRANCE] }
    expect(readInitialLayer1YPos(world(), VMAP, true, via) >> 8).toBe(0x02)
    expect(readInitialLayer2YPos(world(), VMAP, true, via) >> 8).toBe(0x02)
  })
})
