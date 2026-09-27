import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildMap } from '../../../../src/rom/model/MapBuilder'
import type { PixelPos, PixelSize, RenderTarget } from '../../../../src/rom/model/RenderTarget'
import { resetEditorStore } from '../fixtures/stores'
import { VANILLA, hasRom, romPath } from '../../support/corpus'

const ROM_PATH = romPath(VANILLA)

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

describe.skipIf(!hasRom(VANILLA))('MapBuilder end-to-end (vanilla ROM)', () => {
  beforeEach(resetEditorStore)

  it('builds level $0 and renders through the self-rendering chain', () => {
    const rom = SmwRom.open(ROM_PATH)

    const map = buildMap(rom, 0)

    // Structural checks
    expect(map.l1.length).toBeGreaterThan(0)
    expect(map.l1[0].length).toBeGreaterThan(0)
    // Should contain at least some non-empty cells (tiles placed by objects)
    const placed = map.l1.flat().filter(t => t !== null)
    expect(placed.length).toBeGreaterThan(0)

    // Render via mock - proves Map→Tile→SubTile→Char dispatch works end-to-end
    const target = new CountingRenderTarget()
    map.render(target)

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

  it('mapStore is wired with palette + per-level data', () => {
    const rom = SmwRom.open(ROM_PATH)
    const map = buildMap(rom, 0x105)
    expect(map.mapStore.palette).toBe(map.palette)
    expect(map.mapStore.levelOrientation).toBe('horizontal')
    expect(map.mapStore.screenPipeVariantIdx).toEqual(map.screenPipeVariantIdx)
    expect(map.mapStore.marioSpawnX).toBe(map.header.marioStartPx?.x ?? 0)
  })

  it('pins switch-palace blocks to the cleared ($16x) range regardless of #567 (reference webview only)', () => {
    // $105 col 156/row 20 is a yellow switch block (ObjectExpander.test.ts's
    // #567 regression case): the ROM itself draws it uncleared ($06B), but
    // this reference-only path must keep reporting the pre-fix $16B so its
    // serialized/owner-click ids never move under it.
    const rom = SmwRom.open(ROM_PATH)
    const map = buildMap(rom, 0x105)
    expect(map.l1[20][156]).toBe(0x100 | 0x6b)
  })
})
