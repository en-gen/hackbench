/**
 * #636: $7E (flying red coin) and $7F (flying 1-Up) draw a 16 x 16 body plus
 * two 8 x 8 wings in the served interpreter path. The wings come from
 * CODE_019E95 (SMWDisX bank_01.asm:4083-4142), called from CODE_01C27C
 * (bank_01.asm:9040-9041). Needs the vanilla ROM; CI has none, and the
 * interpreter has no synthetic path that reaches a real sprite handler, so
 * this file is skipped there rather than faked.
 */
import { describe, expect, it } from 'vitest'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runOnce, type SpritePart } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { interpDrawer } from '../../../../theia/extension/src/node/map-sprites'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'

const LEVELS = [0x105, 0x106, 0x1c5]

/** The served pass (`passes[chosen]`, as modelResult reads it) as { pos, body parts, wing parts }, from a fresh vanilla or patched ROM. */
function draw(rom: ReturnType<typeof freshRom>, id: number, level: number) {
  const m = runOnce(rom, id, levelSeed(rom, level))
  expect(m.refusal).toBeUndefined()
  const pass = m.passes[m.chosen!]!
  const size = (n: number) => pass.parts.filter((p: SpritePart) => p.size === n)
  return { pos: pass.pos, all: pass.parts, body: size(16), wings: size(8) }
}

describe.skipIf(!hasRom(VANILLA))('flying coin and 1-Up wings (#636), vanilla ROM', () => {
  // Expected wing places, from the routine, not from the probe:
  // CODE_019E95 moves the sprite to (X-2, Y+2) (bank_01.asm:4084-4101), draws
  // the left wing there, then moves X +4 and draws the right one (4117-4129).
  // KoopaWingDispXLo/DispY/Tiles/GfxProp (bank_01.asm:4006-4019), frame 0:
  // left = index 0: dx $FF (-1), dy $FC (-4), tile $5D, prop $46 (X flip);
  // right = index 2 (157C = 1): dx $09, dy $FC, tile $5D, prop $06.
  // So left ox = X-2-1 = X-3, right ox = X-2+4+9 = X+11, both oy = Y+2-4 = Y-2.
  for (const id of [0x7e, 0x7f]) {
    for (const level of LEVELS) {
      it(`$${id.toString(16)} on level $${level.toString(16)}: body plus two mirrored wings`, () => {
        const { pos, all, body, wings } = draw(freshRom(), id, level)
        expect(all).toHaveLength(3)
        expect(body).toHaveLength(1)
        expect(wings).toHaveLength(2)
        const left = wings.find(w => w.flipX)!
        const right = wings.find(w => !w.flipX)!
        expect(left.char).toBe(0x5d)
        expect(right.char).toBe(0x5d)
        expect(left.ox - pos.x).toBe(-3)
        expect(right.ox - pos.x).toBe(11)
        expect(left.oy - pos.y).toBe(-2)
        expect(right.oy - pos.y).toBe(-2)
      })
    }
  }

  // Through the drawer the app serves: 16 x 16 body = 4 EnginePart, each wing = 1.
  it.each([0x7e, 0x7f])(
    'sprite %i via interpDrawer on level 0x105: body (4 parts) plus wings at dx -3 / +11, same tile, mirrored',
    id => {
      const sprite = {
        screen: 0,
        x: 5,
        y: 10,
        spriteId: id,
        extraBit: false,
        raw: [0, 0, 0],
        index: 0,
      }
      const draw = interpDrawer(freshRom(), 0x105, { isVertical: false, screenCount: 0x14 })
      const r = draw(sprite as never)
      if (!r.ok) throw new Error(r.reason)
      const wings = r.parts.filter(p => p.charNum === 0x45d)
      expect(r.parts).toHaveLength(6)
      expect(wings.map(w => [w.dx, w.flipX]).sort()).toEqual([
        [-3, true],
        [11, false],
      ])
      expect(wings.every(w => w.dy === wings[0]!.dy)).toBe(true)
    },
  )

  it('Key $80 is the control: one part, no wings', () => {
    for (const level of LEVELS) expect(draw(freshRom(), 0x80, level).all).toHaveLength(1)
  })

  it('planted defect: NOPing the JSR to CODE_019E95 in CODE_01C27C removes the wings, keeps the body', () => {
    const rom = freshRom()
    // JSR $9E95 is 20 95 9E; two callers exist (bank_01.asm:6187, 9041), so
    // search the CODE_01C27C neighbourhood and require exactly one hit.
    const hits: number[] = []
    for (let a = 0x01c262; a < 0x01c2a0; a++) {
      const b = rom.readAt(a, 3)
      if (b && b[0] === 0x20 && b[1] === 0x95 && b[2] === 0x9e) hits.push(a)
    }
    expect(hits).toEqual([0x01c27c])
    rom.writeAt(hits[0]!, [0xea, 0xea, 0xea])
    for (const id of [0x7e, 0x7f]) {
      const { all, body, wings } = draw(rom, id, 0x105)
      expect(wings).toHaveLength(0)
      expect(body).toHaveLength(1)
      expect(all).toHaveLength(1)
    }
  })
})
