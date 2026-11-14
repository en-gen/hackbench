/**
 * #1176 (D154, Decisions 115-117, "1B 2A 3A"): which sprites get a dashed square on their stored cell, and what a click
 * on one selects. Pure model, synthetic bitmaps, no ROM. Planted defects at the end, each proven red.
 */
import { describe, expect, it } from 'vitest'
import {
  spriteAt,
  storedCell,
  storedSquareAt,
  storedSquares,
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
})

describe('which sprites show a stored square (D154 1B)', () => {
  const onCell = dto(0, [32, 16], [16, 16])
  const piranha = dto(1, [72, 15], [16, 24], { x: 64, y: 16 }) // INIT +8, -1: the art starts 8 px right of the cell
  const far = dto(2, [184, 120], [48, 40], { x: 64, y: 16 }) // moved (+120, +104), art nowhere near the cell
  const big = dto(3, [62, 14], [40, 40], { x: 64, y: 16 }) // moved 2 px up-left but its art still covers the whole cell

  it('a sprite drawn on its own cell shows none, a moved one shows one on its list cell', () => {
    expect(storedSquares([onCell, piranha, far]).map(s => s.index)).toEqual([1, 2])
    expect(storedCell(piranha)).toEqual({ x0: 64, y0: 16, x1: 80, y1: 32 })
  })

  it('a moved sprite whose drawing still covers its whole cell shows none ("only when off its square")', () => {
    expect(storedSquares([big])).toEqual([])
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
})

describe('planted defects (each must turn the matching assertion red)', () => {
  const piranha = dto(1, [72, 15], [16, 24], { x: 64, y: 16 })
  const cover = dto(5, [60, 12], [24, 24])

  it('a marker one cell off its stored position is caught by the cell check', () => {
    const planted = { ...piranha, stored: { x: piranha.stored!.x + 16, y: piranha.stored!.y } }
    expect(storedCell(planted)).not.toEqual({ x0: 64, y0: 16, x1: 80, y1: 32 })
    expect(storedSquareAt(storedSquares([planted]), 66, 20)).toBeUndefined()
  })

  it('letting the drawing win the click would select the covering sprite, which the square test refuses', () => {
    const drawingFirst = (x: number, y: number) => spriteAt([piranha, cover], H, x, y) ?? storedSquareAt(storedSquares([piranha, cover]), x, y) // prettier-ignore
    expect(drawingFirst(66, 20)?.index).toBe(5)
    expect(drawingFirst(66, 20)?.index).not.toBe(storedSquareAt(storedSquares([piranha, cover]), 66, 20)?.index) // prettier-ignore
  })
})
