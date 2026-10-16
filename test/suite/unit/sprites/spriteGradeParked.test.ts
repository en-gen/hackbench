/**
 * passPieces drops exactly what the hardware capture drops: OAM Y == $F0, the
 * parked value (headless_capture.lua:1352 in en-gen/hackbench-validation keeps
 * a frame only when no written entry has Y $F0). A piece at Y 224-255 is on the
 * recorded frame. Synthetic: no ROM.
 */
import { describe, expect, it } from 'vitest'
import type { SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { grade, passPieces } from '../../support/spriteGrade'

const part = (oy: number, size: number) =>
  ({ dx: 0, dy: 0, oy, size, char: oy, attr: 0 }) as unknown as SpriteModel['passes'][0]['parts'][0]
const model = (parts: ReturnType<typeof part>[]): SpriteModel =>
  ({
    id: 0,
    anchor: { x: 0, y: 0, rawX: 0, rawY: 0 },
    passes: [
      { pass: 0, pos: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, parts, uploads: [], palette: [] },
    ],
    chosen: 0,
  }) as unknown as SpriteModel

describe('passPieces and the capture drop rule', () => {
  it('keeps pieces in the 224-255 band and drops only Y == $F0', () => {
    const tiles = passPieces(model([part(232, 16), part(248, 8), part(224, 8), part(0xf0, 8)]), 0)
      .map(p => p.tile)
      .sort((a, b) => a - b)
    expect(tiles).toEqual([224, 232, 248])
  })
})

describe('the report card count and the panel list are one list (#864)', () => {
  it('"model drew N" counts the pieces passPieces holds, not the raw parts', () => {
    const m = model([part(8, 8), part(16, 8), part(0xf0, 8), part(0xf0, 16)])
    const g = grade(m, [[]])
    expect(g.verdict).toBe('wrong')
    expect(g.detail).toBe(`recorded 0 pieces; model drew ${passPieces(m, 0).length}`)
    expect(passPieces(m, 0)).toHaveLength(2)
  })
})
