/**
 * #912: MapBuilder hands buildL2 twelve and buildL3 eight positional arguments, and several share a
 * type (three Maps, four small numbers), so a swap compiles and renders plausibly. This pins every
 * position on a cart built here (no ROM): each scalar is distinct, each object is a sentinel
 * checked by identity, and the call count and arity are exact.
 */
import { describe, it, expect, vi, beforeEach } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom, type MapEntrances } from '../../../../src/rom/SmwRom'
import { SCROLL_SPRITE_BASE } from '../../../../src/rom/L2Loader'
import { buildMapWithGraph } from '../../../../src/rom/model/MapBuilder'
import { buildL2 } from '../../../../src/rom/model/L2Factory'
import { buildL3 } from '../../../../src/rom/model/L3Factory'

// Sentinels the mocked collaborators return, so the builders' inputs can be matched by identity.
const TILES = new Map()
const BG_TILES = new Map()
const L3_CHARS: never[] = []
vi.mock('../../../../src/rom/ObjectExpander', async orig => ({ ...(await orig<object>()), expandMap: () => [] })) // prettier-ignore
vi.mock('../../../../src/rom/model/tiles/TileFactory', async orig => ({ ...(await orig<object>()), buildTiles: () => TILES })) // prettier-ignore
vi.mock('../../../../src/rom/GfxLoader', async orig => ({ ...(await orig<object>()), loadL3Chars: vi.fn(() => L3_CHARS) })) // prettier-ignore
vi.mock('../../../../src/rom/model/L2Factory', async orig => {
  const real = await orig<typeof import('../../../../src/rom/model/L2Factory')>()
  return { ...real, buildBgTiles: () => BG_TILES, buildL2: vi.fn(real.buildL2) }
})
vi.mock('../../../../src/rom/model/L3Factory', async orig => {
  const real = await orig<typeof import('../../../../src/rom/model/L3Factory')>()
  return { ...real, buildL3: vi.fn(real.buildL3) }
})
beforeEach(() => {
  vi.mocked(buildL2).mockClear()
  vi.mocked(buildL3).mockClear()
})

const LEVEL_ID = 0x17
const ENTRANCE = 0x1c3
const SCREENS = 14
const RAW_TILESET = 12
const OVERRIDE_TILESET = 9
const TIME_LIMIT = 2 // header byte 3 bits 7-6
const SCROLL_CMD = 13
const CAM_Y = 0x58 // DATA_05D708[1], picked by the secondary row below
// Header fields MapBuilder can reach. Raw bgPalette (3 bits) is shadowed by the override.
const SPRITE_SET = 0x0a // byte 2 bits 3-0
const RAW_BG_PALETTE = 7 // byte 0 bits 7-5
const OVERRIDE_BG_PALETTE = 11
const BG_COLOR = 6 // byte 1 bits 7-5
const SPRITE_PALETTE = 4 // byte 3 bits 5-3
const FG_PALETTE = 3 // byte 3 bits 2-0
/** Level mode 5 is vertical through the table below; mode 1 is not. */
const MODE = { horizontal: 1, vertical: 5 }
const VERTICAL_TABLE = [0, 0, 0, 0, 0, 1]
const VIA: MapEntrances = { overworld: false, primary: false, secondary: [ENTRANCE] }
const SPRITES_AT = 0x188000 // LoROM, file offset $C0000

function cart(mode: number): { smw: SmwRom; file: RomFile } {
  const file = RomFile.fromBytes('blank.sfc', Buffer.alloc(0x100000))
  file.writeAt(0x00ffd5, [0x20]) // map mode byte SmwRom checks
  file.writeAt(0x05d708, [0x10, CAM_Y, 0xc0, 0x30]) // DATA_05D708 camera Y rows
  file.writeAt(0x05fa00 + ENTRANCE, [1 << 4]) // secondary row: camera index 1
  file.writeAt(SPRITES_AT, [0x00, 0x00, 0x00, SCROLL_SPRITE_BASE + SCROLL_CMD, 0xff])
  // Header: bg palette + length, bg color + mode, music 0 / sprite set, time limit + palettes, raw tileset.
  const level = Buffer.from([
    (RAW_BG_PALETTE << 5) | (SCREENS - 1),
    (BG_COLOR << 5) | mode,
    SPRITE_SET,
    (TIME_LIMIT << 6) | (SPRITE_PALETTE << 3) | FG_PALETTE,
    RAW_TILESET,
    0xff,
  ])
  const smw = Object.assign(Object.create(new SmwRom(file)), {
    rom: file,
    getLevelRawData: () => level,
    getLevelSpritePointer: () => SPRITES_AT,
    requireVerticalTable: () => VERTICAL_TABLE,
  }) as SmwRom
  return { smw, file }
}

describe.each([
  ['horizontal', MODE.horizontal, false],
  ['vertical', MODE.vertical, true],
])('MapBuilder pass-through to the layer builders, %s level', (_n, mode, isVertical) => {
  const built = () => {
    const { smw, file } = cart(mode)
    const out = buildMapWithGraph(smw, LEVEL_ID, {
      objectTileset: OVERRIDE_TILESET,
      bgPalette: OVERRIDE_BG_PALETTE,
      entrances: new Map([[LEVEL_ID, VIA]]),
    })
    return { file, out }
  }

  it('uses scalars no two of which coincide, so a swap cannot pass by equality', () => {
    const scalars = [
      LEVEL_ID,
      SCREENS,
      OVERRIDE_TILESET,
      RAW_TILESET,
      TIME_LIMIT,
      SCROLL_CMD,
      CAM_Y,
    ]
    scalars.push(MODE.horizontal, MODE.vertical, SPRITE_SET, RAW_BG_PALETTE, OVERRIDE_BG_PALETTE)
    scalars.push(BG_COLOR, SPRITE_PALETTE, FG_PALETTE)
    expect(new Set(scalars).size).toBe(scalars.length)
  })

  it('calls buildL2 once with all twelve arguments in order', () => {
    const { file, out } = built()
    expect(buildL2).toHaveBeenCalledTimes(1)
    const a = vi.mocked(buildL2).mock.calls[0]!
    expect(a).toHaveLength(12)
    expect(a[0]).toBe(file)
    expect(a[1]).toBe(LEVEL_ID)
    expect(a[2]).toMatchObject({
      objectTileset: OVERRIDE_TILESET,
      bgPalette: OVERRIDE_BG_PALETTE,
      levelMode: mode,
      timeLimit: TIME_LIMIT,
      spriteSet: SPRITE_SET,
      bgColor: BG_COLOR,
      spritePalette: SPRITE_PALETTE,
      fgPalette: FG_PALETTE,
    })
    expect(a[3]).toBe(SCREENS)
    expect(a[4]).toBe(isVertical)
    expect(a[5]).toBe(out.chars)
    expect(a[6]).toBe(TILES)
    expect(a[7]).toBe(BG_TILES)
    expect(a[8]).toBe(SCROLL_CMD)
    expect(a[9]).toBe(CAM_Y)
    expect(a[10]).toBe(VERTICAL_TABLE)
    expect(a[11]).toBe(VIA)
  })

  it('calls buildL3 once with all eight arguments in order', () => {
    const { file } = built()
    expect(buildL3).toHaveBeenCalledTimes(1)
    const a = vi.mocked(buildL3).mock.calls[0]!
    expect(a).toHaveLength(8)
    expect(a[0]).toBe(file)
    expect(a[1]).toBe(LEVEL_ID)
    expect(a[2]).toBe(OVERRIDE_TILESET) // the effective tileset, not RAW_TILESET
    expect(a[3]).toBe(L3_CHARS)
    expect(a[4]).toBe(SCREENS)
    expect(a[5]).toBe(isVertical)
    expect(a[6]).toBe(TIME_LIMIT) // the raw header's, which no override reaches
    expect(a[7]).toBe(VIA)
  })
})
