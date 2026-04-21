import { describe, it, expect } from 'vitest'
import { ref } from '@vue/reactivity'
import { existsSync } from 'fs'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildMap } from '../../../../src/rom/model/MapBuilder'
import type {
  PixelPos,
  PixelSize,
  RenderContext,
  RenderTarget,
} from '../../../../src/rom/model/RenderTarget'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

class CountingRenderTarget implements RenderTarget {
  blits = 0
  fills = 0
  blit8x8(_p: Uint8Array, _pos: PixelPos, _row: RgbaColor[], _fx: boolean, _fy: boolean): void {
    this.blits++
  }
  fillRect(_pos: PixelPos, _size: PixelSize, _color: RgbaColor): void {
    this.fills++
  }
}

function makeCtx(map: { palette: unknown }): RenderContext {
  return {
    animFrame: ref(0),
    palAnimFrame: ref(0),
    pSwitchActive: ref(false),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette: map.palette as never,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, sprites: true, screens: true, block: true, mapGrid: false }),
  }
}

describe.skipIf(!existsSync(ROM_PATH))('MapBuilder end-to-end (vanilla ROM)', () => {
  it('builds level $0 and renders through the self-rendering chain', () => {
    const rom = SmwRom.open(ROM_PATH)

    const map = buildMap(rom, 0)

    // Structural checks
    expect(map.l1.length).toBeGreaterThan(0)
    expect(map.l1[0].length).toBeGreaterThan(0)
    // Should contain at least some non-empty cells (tiles placed by objects)
    const placed = map.l1.flat().filter(t => t !== null)
    expect(placed.length).toBeGreaterThan(0)

    // Render via mock — proves Map→Tile→SubTile→Char dispatch works end-to-end
    const target = new CountingRenderTarget()
    map.render(makeCtx(map), target)

    // Each placed tile = up to 4 subtile blits (non-priority phase)
    // Most vanilla tiles are all non-priority, so blits > placed * 2 is a
    // safe lower bound.
    expect(target.blits).toBeGreaterThan(placed.length * 2)
  })

  it('builds level $105 (Yoshi Island 1) with expected dimensions', () => {
    const rom = SmwRom.open(ROM_PATH)
    const map = buildMap(rom, 0x105)

    // YI1 is horizontal
    expect(map.header.orientation).toBe('horizontal')
    expect(map.header.tileset).toBe(map.tileset)
    // Horizontal level height is 27 rows
    expect(map.l1.length).toBe(27)
  })
})
