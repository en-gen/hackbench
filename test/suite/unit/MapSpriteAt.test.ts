/**
 * #981: which placed sprite owns a map pixel, by the same stack order `spriteLayer` draws, so the
 * sprite the hover names is the one whose pixel is on screen. Synthetic bitmaps, no ROM.
 */
import { describe, expect, it } from 'vitest'
import {
  spriteAt,
  spriteDoors,
  doorIdAt,
  spriteLabel,
  SpriteStatusOwner,
} from '../../../theia/extension/src/browser/map-view-model'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'

const H = { orientation: 'horizontal' as const, width: 8, height: 2 }
const V = { orientation: 'vertical' as const, width: 2, height: 8 }
const A = [9, 9, 9, 255]
const T = [0, 0, 0, 0]

/** A sprite whose bitmap is `w` x `h` with `holes` (pixel indexes) left transparent. */
const dto = (
  id: number,
  index: number,
  [x, y]: [number, number],
  [w, h]: [number, number] = [2, 1],
  holes: number[] = [],
  extra: Partial<MapSpriteDto> = {},
): MapSpriteDto => ({
  index,
  id,
  x,
  y,
  box: { x0: x, y0: y, x1: x + w, y1: y + h },
  rgba: Buffer.from(Array.from({ length: w * h }, (_, i) => (holes.includes(i) ? T : A)).flat()).toString('base64'), // prettier-ignore
  status: 'drawn',
  ...extra,
})

describe('spriteAt', () => {
  it('names the sprite drawn on top where two overlap: the later in column order, the stream index breaking ties', () => {
    const left = dto(0x33, 0, [1, 0])
    const right = dto(0x10, 1, [2, 0])
    expect(spriteAt([right, left], H, 1, 0)?.id).toBe(0x33)
    expect(spriteAt([right, left], H, 2, 0)?.id).toBe(0x10) // overlap pixel: the later column wins
    expect(spriteAt([left, right], H, 3, 0)?.id).toBe(0x10)
    const a = dto(0x01, 4, [1, 0])
    const b = dto(0x02, 5, [1, 0])
    expect(spriteAt([b, a], H, 1, 0)?.id).toBe(0x02) // same column: the higher stream index
  })

  it('agrees with the door map that decides what is drawn on top', () => {
    const sprites = [dto(0x33, 0, [1, 0]), dto(0x10, 1, [2, 0]), dto(0x20, 2, [2, 0], [2, 2], [0])]
    const doors = spriteDoors({ ...H, sprites }, 0)
    for (let y = 0; y < 2; y++) {
      for (let x = 0; x < 8; x++) {
        const door = doorIdAt(doors, H.width, x, y)
        const order = [...sprites].sort((p, q) => p.x - q.x || p.index - q.index)
        expect(spriteAt(sprites, H, x, y)).toBe(door ? order[door - 1] : undefined)
      }
    }
  })

  it('stacks by row on a vertical map', () => {
    const upper = dto(0x33, 0, [0, 1], [1, 2])
    const lower = dto(0x10, 1, [0, 2], [1, 2])
    expect(spriteAt([upper, lower], V, 0, 2)?.id).toBe(0x10)
    expect(spriteAt([upper, lower], V, 0, 1)?.id).toBe(0x33)
  })

  it('skips a transparent pixel: it falls through to the sprite beneath, or to nothing', () => {
    const under = dto(0x33, 0, [0, 0], [4, 1])
    const over = dto(0x10, 1, [1, 0], [2, 1], [0])
    expect(spriteAt([under, over], H, 1, 0)?.id).toBe(0x33)
    expect(spriteAt([under, over], H, 2, 0)?.id).toBe(0x10)
    expect(spriteAt([under, over], H, 6, 0)).toBeUndefined()
    expect(spriteAt([under, over], H, 4, 0)).toBeUndefined() // x1 is exclusive
    expect(spriteAt([under, over], H, -1, 0)).toBeUndefined()
  })

  it('a sprite the screen door hides still owns its pixels, a Layer 2 flame never does', () => {
    const hidden = dto(0x4f, 11, [3, 0])
    const flame = dto(0xe6, -1, [3, 0], [2, 1], [], { fixedTo: 'layer2' })
    expect(spriteAt([flame, hidden], H, 3, 0)?.id).toBe(0x4f)
    expect(spriteAt([flame], H, 3, 0)).toBeUndefined()
  })

  it('floors a fractional pointer position rather than rounding it', () => {
    const s = dto(0x33, 0, [1, 0], [2, 1])
    expect(spriteAt([s], H, 1.5, 0)).toBe(s)
    expect(spriteAt([s], H, 0.9, 0)).toBeUndefined() // rounds to 1, floors to 0
    expect(spriteAt([s], H, 2.99, 0.9)).toBe(s)
    expect(spriteAt([s], H, 3.0, 0)).toBeUndefined()
  })

  it('reads a non-square bitmap with the right row stride', () => {
    // 3 wide x 2 tall at (2,0); hole 1 is (col 1,row 0), hole 3 is (col 0,row 1), hole 5 is (col 2,row 1).
    const s = dto(0x33, 0, [2, 0], [3, 2], [1, 3, 5])
    const hit = (x: number, y: number) => spriteAt([s], H, x, y) === s
    expect([hit(2, 0), hit(3, 0), hit(4, 0)]).toEqual([true, false, true])
    expect([hit(2, 1), hit(3, 1), hit(4, 1)]).toEqual([false, true, false])
  })

  it('does not hit a pixel with colour but zero alpha', () => {
    const s = dto(0x33, 0, [0, 0], [2, 1], [], {
      rgba: Buffer.from([200, 100, 50, 0, 9, 9, 9, 255]).toString('base64'),
    })
    expect(spriteAt([s], H, 0, 0)).toBeUndefined()
    expect(spriteAt([s], H, 1, 0)).toBe(s)
  })
})

describe('spriteLabel', () => {
  it.each([
    [0x00, 'Goomba', 'Goomba (sprite $00)', 'Sprite $00'],
    [0x0f, 'Goomba', 'Goomba (sprite $0F)', 'Sprite $0F'],
    [0x33, 'Podoboo', 'Podoboo (sprite $33)', 'Sprite $33'],
    [0xff, 'Whatever', 'Whatever (sprite $FF)', 'Sprite $FF'],
  ])('formats case %#', (id, name, named, bare) => {
    expect(spriteLabel({ id, name })).toBe(named)
    expect(spriteLabel({ id })).toBe(bare)
    expect(spriteLabel({ id, name: '' })).toBe(bare)
  })
})

describe('SpriteStatusOwner', () => {
  const fake = () => {
    const entries = new Map<string, string>()
    return {
      entries,
      setElement: (id: string, e: { text: string }) => void entries.set(id, e.text),
      removeElement: (id: string) => void entries.delete(id),
    }
  }
  const [A1, B1] = [
    { id: 0x33, name: 'Podoboo' },
    { id: 0x28, name: 'Big Boo' },
  ]

  it('lets only the owner remove the entry', () => {
    const [bar, own] = [fake(), new SpriteStatusOwner('s', 0)]
    const [a, b] = [{}, {}]
    own.publish(bar, a, A1)
    own.publish(bar, b, B1)
    own.clear(bar, a) // A closes: B's label stays
    expect(bar.entries.get('s')).toBe('Big Boo (sprite $28)')
    own.clear(bar, b)
    expect(bar.entries.has('s')).toBe(false)
  })

  it('claim takes ownership and removes the entry, so the old owner can no longer remove it', () => {
    const [bar, own] = [fake(), new SpriteStatusOwner('s', 0)]
    const [a, b] = [{}, {}]
    own.publish(bar, a, A1)
    own.claim(bar, b) // b is active with nothing selected
    expect(bar.entries.has('s')).toBe(false)
    bar.setElement('s', { text: 'b-owned' }) // stands in for an entry b's own later publish put up
    own.clear(bar, a) // a no longer owns it
    expect(bar.entries.get('s')).toBe('b-owned')
    own.clear(bar, b)
    expect(bar.entries.has('s')).toBe(false)
  })

  it('follows a re-publish by the widget that comes to the front', () => {
    const [bar, own] = [fake(), new SpriteStatusOwner('s', 0)]
    const [a, b] = [{}, {}]
    own.publish(bar, a, A1)
    own.publish(bar, b, B1)
    own.clear(bar, b) // B hides
    own.publish(bar, a, A1) // A shown again
    expect(bar.entries.get('s')).toBe('Podoboo (sprite $33)')
  })
})
