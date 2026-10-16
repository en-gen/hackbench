/**
 * passPieces drops exactly what the hardware capture drops: OAM Y == $F0, the
 * parked value (headless_capture.lua:1352 in en-gen/hackbench-validation keeps
 * a frame only when no written entry has Y $F0). A piece at Y 224-255 is on the
 * recorded frame. Synthetic: no ROM.
 */
import { describe, expect, it } from 'vitest'
import type { SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { passPieces } from '../../support/spriteGrade'

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

describe('passPieces measures from the draw position (#842)', () => {
  it('uses drawPos, not the end-of-pass pos, when they differ', () => {
    const m = model([part(100, 16)])
    m.passes[0]!.pos = { x: 10, y: 20 }
    m.passes[0]!.origin = { x: 10, y: 20 }
    m.passes[0]!.drawPos = { x: 6, y: 17 }
    // piece offset 0 from the origin; the sprite stood 4 left and 3 above it when it drew
    expect(passPieces(m, 0)[0]).toMatchObject({ dx: 4, dy: 3 })
    delete m.passes[0]!.drawPos
    expect(passPieces(m, 0)[0]).toMatchObject({ dx: 0, dy: 0 })
  })
})

describe('passPieces and the capture drop rule', () => {
  it('keeps pieces in the 224-255 band and drops only Y == $F0', () => {
    const tiles = passPieces(model([part(232, 16), part(248, 8), part(224, 8), part(0xf0, 8)]), 0)
      .map(p => p.tile)
      .sort((a, b) => a - b)
    expect(tiles).toEqual([224, 232, 248])
  })
})
