/**
 * An item-block indicator never draws over a sprite pixel that covers its block (#1003). Synthetic, no ROM:
 * the vanilla Playwright case ("a sprite over the item block ... covers its indicator",

 * map-block-contents.spec.cjs) needs the ROM, which CI lacks.
 * Seam: the real `blockIndicators` (which plane a block goes to), the
 * real `screenPlanes` (the plane order) and `IndicatorDisplay` (the compose the view shows), with a
 * stub coin art. The reference webview (src/webview/mapEditor) holds no block indicator at all.
 */
import { describe, it, expect } from 'vitest'
import { screenPlanes, type ListKey } from '../../../src/rom/model/ScreenPlanes'
import { IndicatorDisplay, decodeArts } from '../../../theia/extension/src/browser/map-view-model'
import { blockIndicators } from '../../../theia/extension/src/node/map-block-contents'
import type { BlockContentTables } from '../../../src/rom/BlockContents'
import { hGrid, sub, tile } from '../support/mapInputs'

const COIN = [200, 0, 0, 255]
const SPRITE = [0, 200, 0, 255]
// Content 0 of $111 is a coin on the vanilla layout; the selector, not the ROM, is what matters here.
const TABLES: BlockContentTables = {
  selector: Uint8Array.from({ length: 36 }, () => 0x0c),
  columnCycle: Uint8Array.from({ length: 32 }, () => 0x0c),
  spriteInBlock: new Uint8Array(0xa0),
  statusOfSprInBlk: new Uint8Array(0x80),
  gate: Uint8Array.from({ length: 36 }, () => 0x08),
  columnOverride: new Uint8Array(4),
  columnOverrideStatus: new Uint8Array(4),
  pSwitchAttribute: new Uint8Array(2),
  eggContents: new Uint8Array(2),
  greenStarCoins: 7,
}
const solid = (c: number[]) => Uint8ClampedArray.from({ length: 16 * 16 * 4 }, (_, i) => c[i % 4]!)

/** The shown pixel (x, y) of a 32 x 32 screen with one item block at cell (1, 1) and one sprite pixel at (28, 28), inside the indicator's quadrant. */
function shown(highPriorityBlock: boolean, spriteKey: ListKey, doors = false) {
  const tiles: ReturnType<typeof tile>[] = []
  tiles[0x111] = tile(0x111, [sub(0), sub(0), sub(0), sub(0, 0, highPriorityBlock)])
  const grid = hGrid(2)
  grid[1]![1] = 0x111
  const art = { art: solid(COIN) }
  const { indicators, arts } = blockIndicators(
    { grid, map16: { tiles, pipeVariants: [] }, l2: undefined, isVertical: false, screenCount: 2 },
    TABLES,
    { coin: () => art, sprite: () => art },
  ) as never as { indicators: { plane: never; x: number; y: number; art: string }[]; arts: Record<string, string> } // prettier-ignore
  const lists = screenPlanes(0x13, 0, false)
  const planes: Record<string, Uint8ClampedArray | null> = Object.fromEntries(
    lists.main.map(k => [k, null]),
  )
  const px = new Uint8ClampedArray(32 * 32 * 4)
  px.set(SPRITE, (28 * 32 + 28) * 4)
  planes[spriteKey] = px
  // The view passes the sprites' door map when they show (map-view-widget.tsx), so a covered pixel is not hidden (D52).
  const door = doors ? new Uint32Array(32 * 32) : null
  if (door) door[28 * 32 + 28] = (1 << 1) | 1 // sprite id 1, parity 1: the dim square
  const base = new Uint8ClampedArray(32 * 32 * 4)
  const d = new IndicatorDisplay({
    width: 32, height: 32, zoom: 1, screen: 0, geometry: { orientation: 'horizontal', width: 32, height: 32 }, // prettier-ignore
    planes: planes as never, lists, math: null, doors: door, base, indicators, arts: decodeArts(arts),
  }) // prettier-ignore
  return { at: (x: number, y: number) => Array.from(d.image.subarray((y * 32 + x) * 4, (y * 32 + x) * 4 + 4)), planes: indicators.map(i => i.plane) } // prettier-ignore
}

describe('an item-block indicator under a sprite pixel', () => {
  // Sprites 0 and 1 draw behind Layer 1 altogether, so only 2 and 3 can cover a Layer 1 block's indicator.
  it.each([
    ['low-priority', false, 'sprites2'],
    ['low-priority', false, 'sprites3'],
    ['high-priority', true, 'sprites3'],
  ] as const)('a $0 block: a $2 pixel is not covered by its indicator', (_n, high, key) => {
    const s = shown(high, key)
    expect(s.at(28, 28), 'the sprite pixel, not the indicator').toEqual(SPRITE)
    expect(s.at(30, 30), 'the indicator still shows beside the sprite pixel').toEqual(COIN)
    expect(s.planes).toEqual([high ? 'l1High' : 'l1Low'])
  })
})

describe('an item-block indicator over a sprite pixel', () => {
  // OBJ.2 sits before l1High, so a high-priority block's indicator covers it; D52 (docs/rom/obj-priority.md)
  // draws the covered pixel through the screen door instead of hiding it: a blend, neither pure color.
  it('covers a sprites2 pixel behind a high-priority block, which shows through the door', () => {
    const s = shown(true, 'sprites2', true)
    const [r, g, b] = s.at(28, 28)
    expect(s.at(28, 28), 'not the plain sprite colour').not.toEqual(SPRITE)
    expect(s.at(28, 28), 'not the plain indicator either').not.toEqual(COIN)
    expect([r! > 0, g! > 0, b], 'the indicator colour is in the blend').toEqual([true, true, 0])
    expect(s.at(30, 30), 'the indicator beside it is plain').toEqual(COIN)
  })
})
