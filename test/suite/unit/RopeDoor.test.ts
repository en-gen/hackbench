/**
 * The rope's extra length in the screen door (#1230, D152): the parts the merge tags `door` reach the browser as door pixels
 * of their own id while the rest of the sprite stays solid, and over a tile the dim door pixels keep the tile's color math
 * (D60 B, as for #1132's whole door). Synthetic: parts -> `drawSprites` -> `spriteDoors` -> `composeScreen`, no ROM.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { composeScreen, doorFlips, WHOLE_DOOR } from '../../../src/rom/model/ColorMath'
import type { SpritePart } from '../../../src/rom/sprites/interp/SpriteRunner'
import {
  compositeSpriteScreen,
  spriteDoors,
} from '../../../theia/extension/src/browser/map-view-model'
import { drawSprites, interpParts } from '../../../theia/extension/src/node/map-sprites'
import { COLORS, px } from '../support/mapInputs'

const MODEL = { vram: { sp1: [new Uint8Array(64).fill(1)] }, colors: COLORS }
const G = { orientation: 'horizontal' as const, width: 8, height: 32 }
const spr = { index: 0, x: 0, y: 0, spriteId: 0x64, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as unknown as LevelSprite // prettier-ignore
const part = (dy: number, door?: true): SpritePart => ({ oam: 0, char: 0, size: 8, palette: 9, priority: 2, flipX: false, flipY: false, dx: 0, dy, attr: 0, ox: 0, oy: 0, ...(door ? { door } : {}) }) // prettier-ignore
const identity = { spriteId: 0x64, mainHandler: 0, initHandler: 0, status: 'vanilla' as const }
/** Three parts down a column of 8 px cells; `doored` says which are in the door. */
const dto = (doored: boolean[]) => drawSprites([spr], MODEL, () => ({ ok: true, parts: interpParts(doored.map((d, i) => part(i * 8, d || undefined))), anchor: { x: 0, y: 0 }, identity }))[0]! // prettier-ignore
const wordsOf = (doored: boolean[]) => spriteDoors({ ...G, sprites: [dto(doored)] }, 0)!
const at = (w: Uint32Array, cell: number, x = 0) => w[cell * 8 * 8 + x] >> 1

describe('door parts of one sprite', () => {
  it('only the tagged cells carry WHOLE_DOOR, under an id of their own', () => {
    const w = wordsOf([false, false, true])
    expect(at(w, 0) & WHOLE_DOOR).toBe(0)
    expect(at(w, 1) & WHOLE_DOOR).toBe(0)
    expect(at(w, 2) & WHOLE_DOOR).toBe(WHOLE_DOOR)
    expect(at(w, 2)).not.toBe(at(w, 0) | WHOLE_DOOR) // not the solid cells' id with the flag: its own
    expect(at(w, 0)).toBe(at(w, 1))
  })
  it('a sprite with no tagged part has no door word flagged', () => {
    const w = wordsOf([false, false, false])
    for (let cell = 0; cell < 3; cell++) expect(at(w, cell) & WHOLE_DOOR).toBe(0)
  })
  it('composed over a tile: solid cells stay full strength, door cells alternate, and the tile keeps its color math', () => {
    const doors = wordsOf([false, false, true])
    const sprite = new Uint8ClampedArray(composeSprite(G, doors))
    const tile = new Uint8ClampedArray(8 * 32 * 4).fill(255)
    const out = composeScreen({ width: 8, height: 32, planes: { sprites2: sprite, l1Low: tile }, lists: { main: ['l1Low', 'sprites2'], sub: [] }, math: null, doors, flips: doorFlips({ width: 8, height: 32, planes: {}, lists: { main: [], sub: [] }, math: null, doors }) }) // prettier-ignore
    const solid = px(out, 8, 0, 0)
    for (let y = 0; y < 16; y++) for (let x = 0; x < 8; x++) expect(px(out, 8, x, y)).toEqual(solid)
    const door = new Set<string>()
    for (let y = 16; y < 24; y++) for (let x = 0; x < 8; x++) door.add(px(out, 8, x, y).join())
    expect(door.size).toBe(2) // full strength and dim squares
    expect(door.has(solid.join())).toBe(true)
  })
})

/** The sprite plane of the one sprite on screen 0, read back through the same layer the door words come from. */
function composeSprite(g: typeof G, _doors: Uint32Array): Uint8ClampedArray {
  return compositeSpriteScreen([dto([false, false, true])], 0, g)!
}
