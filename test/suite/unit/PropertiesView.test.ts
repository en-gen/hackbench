/**
 * #984: the Properties view's sprite subject. Everything is derived from the `MapSpriteDto` the map view
 * draws from, so the parts list, palette rows and box cannot drift from the picture. Synthetic chars and
 * DTOs only (no ROM bytes); CI needs no cart.
 */
import { describe, it, expect } from 'vitest'
import type { EngineResult } from '../../../src/rom/model/sprites/generic/SpriteDrawEngine'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { drawSprites } from '../../../theia/extension/src/node/map-sprites'
import {
  NOT_ANIMATED,
  partsBounds,
  spriteProps,
} from '../../../theia/extension/src/browser/sprite-props'
import { PropertiesModel } from '../../../theia/extension/src/browser/properties-model'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import { COLORS } from '../support/mapInputs'

const SOLID = new Uint8Array(64).fill(1)
const MODEL = { vram: { sp1: [SOLID, SOLID] }, colors: COLORS }
const spr = (x: number, y: number, spriteId = 0x10): LevelSprite =>
  ({
    index: 0,
    x,
    y,
    spriteId,
    screen: 0,
    extraBit: false,
    raw: [],
    streamOffset: 0,
  }) as LevelSprite
const part = (charNum: number, palette: number, dx: number, dy: number, flipX = false) => ({
  charNum,
  palette,
  flipX,
  flipY: false,
  dx,
  dy,
})
const ok = (...parts: ReturnType<typeof part>[]): EngineResult =>
  ({ ok: true, parts, identity: { spriteId: 0x10, mainHandler: 0, initHandler: 0, status: 'vanilla' } }) as EngineResult // prettier-ignore

const PARTS = [part(0x400, 9, 0, 0), part(0x401, 10, 8, 0, true), part(0x400, 9, -8, 8)]
const draw = (id = 0x10) => drawSprites([spr(5, 3, id)], MODEL, () => ok(...PARTS))[0]!

describe('spriteProps: the parts are the ones the map view drew (acceptance 5)', () => {
  it('lists every part drawSprites placed, with the palette rows they use', () => {
    const p = spriteProps({ ...draw(), name: 'Rex' })
    expect(p.parts).toHaveLength(PARTS.length)
    expect(p.parts!.map(x => x.palette)).toEqual(PARTS.map(x => x.palette))
    expect(p.parts![1]).toMatchObject({ char: 0x401, flipX: true, flipY: false, dx: 8, dy: 0 })
    expect(p.paletteRows).toEqual([9, 10])
  })

  it('the parts span exactly the bitmap box the view draws', () => {
    const dto = draw()
    const b = partsBounds(dto.parts!)
    expect({ x0: dto.x + b.x0, y0: dto.y + b.y0, x1: dto.x + b.x1, y1: dto.y + b.y1 }).toEqual(
      dto.box,
    )
  })

  it('a placeholder has no parts to list and says why', () => {
    const [m] = drawSprites([spr(1, 1, 0x1a)], MODEL, () => ({ ok: false, failure: { kind: 'noDescriptor', spriteId: 0x1a } }) as EngineResult) // prettier-ignore
    const p = spriteProps(m!)
    expect(p.parts).toBeNull()
    expect(p.paletteRows).toEqual([])
    expect(p.notes.join(' ')).toMatch(/not drawn/i)
  })
})

describe('spriteProps: identity and position in words', () => {
  it('names the sprite and gives its column and row in 16 px tiles', () => {
    const p = spriteProps({ ...draw(0x33), name: 'Podoboo' })
    expect(p).toMatchObject({ label: 'Podoboo (sprite $33)', col: 5, row: 3 })
  })
  it('an unnamed sprite is still labelled by id', () => {
    expect(spriteProps(draw(0x7e)).label).toBe('Sprite $7E')
  })
})

describe('spriteProps: animation', () => {
  it('the map view holds one frame per sprite, so the pane says so and offers no loop', () => {
    const p = spriteProps(draw())
    expect(p.animation).toEqual({ animated: false, text: NOT_ANIMATED })
    expect(NOT_ANIMATED).toMatch(/not animated/i)
  })
})

describe('PropertiesModel: the subject switches with the map view selection', () => {
  const a = {}
  const b = {}
  const sprite = { kind: 'sprite', sprite: {} as MapSpriteDto } as const
  it('starts empty, shows a published sprite, clears on the owner clear', () => {
    const m = new PropertiesModel()
    const seen: string[] = []
    m.onChange(s => seen.push(s.kind))
    expect(m.subject.kind).toBe('none')
    m.publish(a, sprite)
    expect(m.subject.kind).toBe('sprite')
    m.clear(a)
    expect(m.subject.kind).toBe('none')
    expect(seen).toEqual(['sprite', 'none'])
  })
  it("a map that is not the owner cannot clear another map's sprite (closing a background map)", () => {
    const m = new PropertiesModel()
    m.publish(a, sprite)
    m.publish(b, { kind: 'none' })
    m.clear(a)
    m.publish(b, sprite)
    m.clear(a)
    expect(m.subject.kind).toBe('sprite')
    m.clear(b)
    expect(m.subject.kind).toBe('none')
  })
})
