import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildMap } from '../../../../src/rom/model/MapBuilder'
import type { PixelPos, PixelSize, RenderTarget } from '../../../../src/rom/model/RenderTarget'
import { resetEditorStore } from '../fixtures/stores'
import { VANILLA, freshRom, hasRom, romPath } from '../../support/corpus'

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

  // #860: no vanilla map is entered only through secondary entrances, so the entrances are injected
  // and the row they name is planted. The synthetic witnesses for every other call site are in
  // EntranceVia.synthetic.test.ts; a whole map build needs the cart's tables.
  it('a map entered only through a secondary entrance draws the camera of that entrance', () => {
    const raw = freshRom()
    raw.writeAt(0x05fa00 + 0x1c3, [0x10]) // L1 index 1: DATA_05D708[1], where $105's primary row gives index 2
    const rom = new SmwRom(raw)
    const only = new Map([[0x105, { overworld: false, primary: false, secondary: [0x1c3] }]])
    const [secondary, primary, noGraph] =
      [{ entrances: only }, { entrances: new Map() }, { entrances: undefined }] // prettier-ignore
        .map(o => buildMap(rom, 0x105, o).header.initialCameraYPx)
    expect([secondary, primary, noGraph]).toEqual([0x60, 0xc0, 0xc0])
  })
})
