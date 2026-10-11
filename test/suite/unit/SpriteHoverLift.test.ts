/**
 * Hover lifts a sprite out of the hidden-tile screen door (#879, D52 part 1): the hovered sprite's
 * covered pixels draw at full strength, everything else is as without a lift. Synthetic planes, no ROM.
 */
import { describe, it, expect } from 'vitest'
import { composeScreen, type ScreenInput } from '../../../src/rom/model/ColorMath'
import { screenPlanes } from '../../../src/rom/model/ScreenPlanes'
import { doorIdAt } from '../../../theia/extension/src/browser/map-view-model'

const W = 8
const H = 2
const L1 = [7, 8, 9]
const A = [200, 10, 20]
const B = [30, 220, 40]

/** Sprite A on columns 0-3, sprite B on columns 2-5 (B on top where they meet); the tile covers `covered`. */
function run(covered: (x: number) => boolean, lift?: number) {
  const sprites = new Uint8ClampedArray(W * H * 4)
  const l1 = new Uint8ClampedArray(W * H * 4)
  const doors = new Uint32Array(W * H)
  for (let y = 0; y < H; y++)
    for (let x = 0; x < W; x++) {
      const p = y * W + x
      if (covered(x)) l1.set([...L1, 255], p * 4)
      const id = x >= 2 && x <= 5 ? 2 : x <= 3 ? 1 : 0
      if (!id) continue
      sprites.set([...(id === 1 ? A : B), 255], p * 4)
      doors[p] = (id << 1) | ((x + y) & 1)
    }
  const input: ScreenInput = { width: W, height: H, planes: { l1High: l1, sprites2: sprites }, lists: screenPlanes(0x15, 0x00, false), math: null, doors, lift } // prettier-ignore
  return { out: composeScreen(input), doors }
}
const at = (o: Uint8ClampedArray, x: number, y: number) =>
  Array.from(o.subarray((y * W + x) * 4, (y * W + x) * 4 + 4))
const all = () => true

describe('lift draws the hovered covered sprite opaque (#879)', () => {
  it('both checkerboard parities show the sprite colour at every covered pixel of that sprite', () => {
    const { out } = run(all, 1)
    for (const x of [0, 1])
      for (let y = 0; y < H; y++) expect(at(out, x, y), `${x},${y}`).toEqual([...A, 255])
  })
  it('no lift, or a lift naming no sprite, is byte-identical to the door', () => {
    const plain = run(all).out
    expect(run(all, 0).out).toEqual(plain)
    expect(run(all, 9).out).toEqual(plain)
    expect(at(plain, 1, 0)).not.toEqual([...A, 255])
  })
  it('lifting one of two overlapping sprites leaves the other door intact', () => {
    const plain = run(all).out
    const lifted = run(all, 1).out
    // B owns columns 2-5, so those pixels are unchanged when A is lifted; and the reverse.
    for (const x of [2, 3, 4, 5]) for (let y = 0; y < H; y++) expect(at(lifted, x, y)).toEqual(at(plain, x, y)) // prettier-ignore
    const liftB = run(all, 2).out
    for (const x of [0, 1]) for (let y = 0; y < H; y++) expect(at(liftB, x, y)).toEqual(at(plain, x, y)) // prettier-ignore
    for (const x of [2, 3, 4, 5]) for (let y = 0; y < H; y++) expect(at(liftB, x, y)).toEqual([...B, 255]) // prettier-ignore
  })
  it('an uncovered sprite is unchanged by the lift', () => {
    const none = run(() => false).out
    expect(run(() => false, 1).out).toEqual(none)
    expect(run(() => false, 2).out).toEqual(none)
  })
  it('only the covered part of a partly covered sprite changes', () => {
    const plain = run(x => x >= 1).out
    const lifted = run(x => x >= 1, 1).out
    expect(at(lifted, 0, 0)).toEqual(at(plain, 0, 0))
    expect(at(lifted, 1, 0)).toEqual([...A, 255])
  })
})

describe('doorIdAt, the hover hit test', () => {
  const { doors } = run(all)
  it('names the topmost sprite at a pixel, 0 off every sprite and outside the screen', () => {
    expect(doorIdAt(doors, W, 0, 0)).toBe(1)
    expect(doorIdAt(doors, W, 3.9, 1.2)).toBe(2)
    expect(doorIdAt(doors, W, 7, 0)).toBe(0)
    for (const [x, y] of [[-1, 0], [W, 0], [0, -1], [0, H]]) expect(doorIdAt(doors, W, x!, y!)).toBe(0) // prettier-ignore
    expect(doorIdAt(null, W, 0, 0)).toBe(0)
  })
})
