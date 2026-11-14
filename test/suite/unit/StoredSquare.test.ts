/**
 * #1176 (D154, Decisions 115-117, "1B 2A 3A"): which sprites get a dashed square on their stored cell, what a click on one
 * selects, and what its hover says. Pure model, synthetic bitmaps, no ROM. Every test runs the production functions only: a
 * planted defect in them (a cell one tile off, the drawing winning the click, a wrong cover test) turns these red.
 */
import { describe, expect, it } from 'vitest'
import {
  spriteAt,
  spriteHover,
  storedCell,
  storedSquareAt,
  storedSquares,
  STORED_SQUARE_TIP,
} from '../../../theia/extension/src/browser/map-view-model'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'

const H = { orientation: 'horizontal' as const, width: 8, height: 2 }
const OPAQUE = [9, 9, 9, 255]

/** A sprite drawn at (x, y) with an opaque w x h bitmap; `stored` set when its list tile is elsewhere. */
const dto = (
  index: number,
  [x, y]: [number, number],
  [w, h]: [number, number],
  stored?: { x: number; y: number },
  extra: Partial<MapSpriteDto> = {},
): MapSpriteDto => ({
  // prettier-ignore
  index,
  id: 0x4f,
  x,
  y,
  box: { x0: x, y0: y, x1: x + w, y1: y + h },
  rgba: Buffer.from(Array.from({ length: w * h }, () => OPAQUE).flat()).toString('base64'),
  status: 'drawn',
  ...(stored ? { stored } : {}),
  ...extra,
})

describe('which sprites show a stored square (D154 1B)', () => {
  const onCell = dto(0, [32, 16], [16, 16])
  const piranha = dto(1, [72, 15], [16, 24], { x: 64, y: 16 }) // INIT +8, -1: the art starts 8 px right of the cell
  const far = dto(2, [184, 120], [48, 40], { x: 64, y: 16 }) // moved (+120, +104), art nowhere near the cell
  const big = dto(3, [62, 14], [40, 40], { x: 64, y: 16 }) // moved 2 px up-left but its art still covers the whole cell

  it('a sprite drawn on its own cell shows none, a moved one shows one on its list cell', () => {
    expect(storedSquares([onCell, piranha, far]).map(s => s.index)).toEqual([1, 2])
    expect(storedCell(piranha)).toEqual({ x0: 64, y0: 16, x1: 80, y1: 32 })
    expect(storedCell(onCell)).toBeUndefined()
  })

  it('a moved sprite whose drawing still covers its whole cell shows none ("only when off its square")', () => {
    expect(storedSquares([big])).toEqual([])
  })

  it('the cover test is exact at every edge: a drawing one pixel short on any side still shows the square', () => {
    const stored = { x: 64, y: 16 } // cell 64..80 by 16..32
    const box = (x0: number, y0: number, x1: number, y1: number): MapSpriteDto => ({ ...dto(9, [x0, y0], [x1 - x0, y1 - y0], stored) }) // prettier-ignore
    expect(storedSquares([box(64, 0, 80, 32)]), 'exactly covering').toEqual([])
    expect(storedSquares([box(65, 0, 80, 32)]).length, 'left edge one short').toBe(1)
    expect(storedSquares([box(64, 0, 79, 32)]).length, 'right edge one short').toBe(1)
    expect(storedSquares([box(64, 17, 80, 40)]).length, 'top edge one short').toBe(1)
    expect(storedSquares([box(64, 0, 80, 31)]).length, 'bottom edge one short').toBe(1)
  })

  it('a sprite fixed to Layer 2 gets none, as spriteAt leaves it out of the hit test', () => {
    const fixed = dto(4, [72, 15], [16, 24], { x: 64, y: 16 }, { fixedTo: 'layer2' }) // prettier-ignore
    expect(storedSquares([fixed])).toEqual([])
  })

  it('the squares follow the data: a sprite served again with another stored cell moves its square (AC5)', () => {
    const before = dto(1, [72, 15], [16, 24], { x: 64, y: 16 })
    const after = dto(1, [88, 47], [16, 24], { x: 80, y: 48 }) // an edit moved the stored tile; the reply says so
    expect(storedCell(storedSquares([before])[0]!)).toEqual({ x0: 64, y0: 16, x1: 80, y1: 32 })
    expect(storedCell(storedSquares([after])[0]!)).toEqual({ x0: 80, y0: 48, x1: 96, y1: 64 })
  })
})

describe('clicking a shown square (D154 3A)', () => {
  const piranha = dto(1, [72, 15], [16, 24], { x: 64, y: 16 })
  // Another sprite whose drawing sits on top of the piranha's stored cell.
  const cover = dto(5, [60, 12], [24, 24])
  const squares = storedSquares([piranha, cover])

  it("selects the square's sprite, though another sprite's drawing covers it", () => {
    expect(spriteAt([piranha, cover], H, 66, 20)?.index, 'the drawing alone would win').toBe(5)
    expect(storedSquareAt(squares, 66, 20)?.index).toBe(1)
  })

  it('its edges are the cell: 64..79 by 16..31, and nothing outside', () => {
    expect(storedSquareAt(squares, 64, 16)?.index).toBe(1)
    expect(storedSquareAt(squares, 79.9, 31.9)?.index).toBe(1)
    expect(storedSquareAt(squares, 80, 20)).toBeUndefined()
    expect(storedSquareAt(squares, 63, 20)).toBeUndefined()
    expect(storedSquareAt(squares, 70, 32)).toBeUndefined()
  })

  it('two squares on one cell: the later one in the list is on top', () => {
    const a = dto(1, [200, 15], [16, 24], { x: 64, y: 16 })
    const b = dto(2, [300, 15], [16, 24], { x: 64, y: 16 })
    expect(storedSquareAt(storedSquares([a, b]), 70, 20)?.index).toBe(2)
    expect(storedSquareAt(storedSquares([b, a]), 70, 20)?.index).toBe(1)
  })
})

describe('the hover on a stored square (D154, #1176 AC8)', () => {
  const piranha = { ...dto(1, [72, 15], [16, 24], { x: 64, y: 16 }), name: 'Piranha Plant' }

  it('says in plain words that it is stored here and drawn elsewhere, anchored on the cell', () => {
    const h = spriteHover(piranha, true)
    expect(h.content).toBe(STORED_SQUARE_TIP)
    expect(h.content).toMatch(/stored here.*drawn elsewhere/i)
    expect(h.content).not.toMatch(/github|#\d/i)
    expect(h.box).toEqual({ x0: 64, y0: 16, x1: 80, y1: 32 })
  })

  it("over the drawing it is the sprite's own name, anchored on its box", () => {
    const h = spriteHover(piranha, false)
    expect(h.content).toBe('Piranha Plant')
    expect(h.box).toEqual(piranha.box)
  })
})
