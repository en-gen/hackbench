/**
 * src/rom/TileRenderer.ts's renderSubTile (#421 step 2): retired its own
 * flip-and-compose in favor of the core's `composeTile`
 * (src/rom/render/TileResolver.ts), the same function
 * tools/scripts/capture_draw.ts's foreground() calls and capture:render
 * proves pixel-for-pixel against Mesen. This is the shipping Map16 editor's
 * atlas (theia/extension/src/node/map16-decode.ts -> buildTileAtlas), so
 * these pin that the app's own pixels did not change under the move.
 */
import { createHash } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { loadAllMap16, type Map16Tile, type SubTile } from '../../../src/rom/Map16'
import { buildLevelCgram, loadRomPalettes, STOCK_COL1 } from '../../../src/rom/PaletteLoader'
import { loadVram } from '../../../src/rom/GfxLoader'
import { buildTileAtlas, renderMap16Tile } from '../../../src/rom/TileRenderer'
import type { RgbaColor } from '../../../src/rom/GraphicsDecoder'
import type { VramState } from '../../../src/rom/GfxLoader'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { RomFile } from '../../../src/rom/RomFile'

const ROM_PATH = romPath(VANILLA)
const romPresent = hasRom(VANILLA)

// The atlas as it rendered on develop, before the core-resolver move
// (#421 step 2): tileset 0's first 24 Map16 tiles, 8 per row, vanilla ROM.
// Captured with `buildTileAtlas` prior to this change and pinned here so a
// regression in the moved code (a flip or color-row defect in the core's
// `composeTile`) shows up as a changed hash, not just a passing rebuild.
const BASELINE_ATLAS_SHA256 = '6aac59cc0b6710432fb85348fb065984d43e820ed60b9aa10c8bbe1fb66613f2'

describe.skipIf(!romPresent)('Map16 tile atlas vs the pre-move baseline (ROM-only)', () => {
  it('renders the same bytes through the core resolver as it did before the move', () => {
    const rom = RomFile.load(ROM_PATH)
    const tiles = loadAllMap16(rom, 0).slice(0, 24)
    const vram = loadVram(rom, 0)
    const palettes = loadRomPalettes(rom)
    const cgram = buildLevelCgram(palettes, 0, 0, 0, STOCK_COL1)
    const { atlas } = buildTileAtlas(tiles, vram, cgram, 8)
    const hash = createHash('sha256').update(Buffer.from(atlas)).digest('hex')
    expect(hash).toBe(BASELINE_ATLAS_SHA256)
  })
})

/** A one-char VramState: `getCharPixels` finds char 0 in slot fg1 (base 0). */
function oneCharVram(pixels: number[]): VramState {
  return { fg1: [Uint8Array.from(pixels)] }
}

const subtile = (over: Partial<SubTile> = {}): SubTile => ({
  charNum: 0,
  palette: 0,
  priority: false,
  flipX: false,
  flipY: false,
  ...over,
})

const solidTile = (over: Partial<SubTile> = {}): Map16Tile => {
  const s = subtile(over)
  return { id: 0, tl: s, tr: s, bl: s, br: s }
}

/**
 * A synthetic char whose 64 indices are `y*8+x` mod 16 (row 0 col 0 = index
 * 0, i.e. transparent; every other cell distinct), so a flip is visible as a
 * different color at a fixed screen position, and a wrong color-row shift
 * (e.g. reading row N+1) is visible as a different RGB entirely.
 */
const RAMP = Array.from({ length: 64 }, (_, i) => i % 16)

/** Two distinct 16-color rows so a wrong row lands on visibly wrong RGB. */
function twoRowPalette(): { colors: RgbaColor[] } {
  const row0 = Array.from({ length: 16 }, (_, i) => [i, 0, 0, 255] as RgbaColor)
  const row1 = Array.from({ length: 16 }, (_, i) => [0, i, 0, 255] as RgbaColor)
  return { colors: [...row0, ...row1] }
}

describe('renderMap16Tile composes through the core resolver (synthetic, no cartridge)', () => {
  // Screen pixel (3, 2) of the TL subtile, char index (y*8+x)%16 unflipped.
  // flipX reads char column 7-3=4 (index 4); flipY reads char row 7-2=5,
  // column 3 (index (5*8+3)%16=11) - a swapped flip axis would land on the
  // other one, so these also catch flipX/flipY reversed. palette 1 must
  // land on the green-ramped row 1, never red-ramped row 0.
  it.each([
    ['un-flipped', {}, [3, 0, 0]],
    ['flipX only', { flipX: true }, [4, 0, 0]],
    ['flipY only', { flipY: true }, [11, 0, 0]],
    ['palette 1', { palette: 1 }, [0, 3, 0]],
  ] as const)('%s: pixel (3, 2) reads %j', (_name, over, expected) => {
    const rgba = renderMap16Tile(solidTile(over), oneCharVram(RAMP), twoRowPalette())
    const off = 2 * (16 * 4) + 3 * 4
    expect([rgba[off], rgba[off + 1], rgba[off + 2]]).toEqual(expected)
  })

  it('leaves color index 0 transparent (alpha 0), never opaque black', () => {
    const vram = oneCharVram(RAMP)
    const tile = solidTile()
    const rgba = renderMap16Tile(tile, vram, twoRowPalette())
    // TL pixel (0, 0): char index (0*8+0)%16 = 0 -> transparent, composeTile's
    // `put` never called, so the fresh (zero) buffer stays (0, 0, 0, 0).
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([0, 0, 0, 0])
  })

  it('draws a magenta placeholder for a char missing from VRAM entirely, not a transparent one', () => {
    const tile = solidTile({ charNum: 5 }) // char 5 is not in the one-char VramState
    const rgba = renderMap16Tile(tile, oneCharVram(RAMP), twoRowPalette())
    expect([rgba[0], rgba[1], rgba[2], rgba[3]]).toEqual([255, 0, 255, 128])
  })
})
