/**
 * The rope's extra length in the screen door (#1230, D152): tagged parts reach the browser as door pixels under an id of their
 * own while the rest of the sprite stays solid, in the priority planes, over a tile and past the map edge (the dim pixel's
 * tile color math is WholeDoor.test.ts's claim, per pixel). Synthetic, no ROM.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { composeScreen, doorFlips, WHOLE_DOOR } from '../../../src/rom/model/ColorMath'
import { SPRITE_KEYS } from '../../../src/rom/model/ScreenPlanes'
import type { SpritePart } from '../../../src/rom/sprites/interp/SpriteRunner'
import { offMapSpritePixels } from '../../../theia/extension/src/browser/off-map-extent'
import {
  compositeSpriteScreen,
  spriteDoors,
  spritePlanes,
} from '../../../theia/extension/src/browser/map-view-model'
import { drawSprites, interpParts } from '../../../theia/extension/src/node/map-sprites'
import { COLORS, px } from '../support/mapInputs'

const MODEL = { vram: { sp1: [new Uint8Array(64).fill(1)] }, colors: COLORS }
const [W, G] = [48, { orientation: 'horizontal' as const, width: 48, height: 32 }]
const identity = { spriteId: 0x64, mainHandler: 0, initHandler: 0, status: 'vanilla' as const }
/** Three 8 px cells down tile column `col`; `door[i]` puts cell i in the door; `pri` is every cell's OAM priority. */
const dto = (door: boolean[], pri = 2, col = 0) => {
  const spr = {
    index: 0,
    x: col,
    y: 0,
    spriteId: 0x64,
    screen: 0,
    extraBit: false,
    raw: [],
    streamOffset: 0,
  } as unknown as LevelSprite
  const parts = door.map((d, i): SpritePart => ({
    oam: 0,
    char: 0,
    size: 8,
    palette: 9,
    priority: pri,
    flipX: false,
    flipY: false,
    dx: 0,
    dy: i * 8,
    attr: 0,
    ox: 0,
    oy: 0,
    ...(d ? { door: true as const } : {}),
  }))
  return drawSprites([spr], MODEL, () => ({
    ok: true,
    parts: interpParts(parts),
    anchor: { x: col * 16, y: 0 },
    identity,
  }))[0]!
}
const ROPE = [false, false, true]
const SOLID = [false, false, false]
/** The door id (word >> 1) of cell `cell` of the sprite in tile column `col`. */
const idAt = (w: Uint32Array, cell: number, col = 0) => w[cell * 8 * W + col * 16] >> 1

describe('door parts of one sprite', () => {
  it('only the tagged cells carry WHOLE_DOOR, under an id that follows the stack place (n + 1 = 3) with the door-part bit', () => {
    const w = spriteDoors(
      { ...G, sprites: [dto(SOLID, 2, 0), dto(SOLID, 2, 1), dto(ROPE, 2, 2)] },
      0,
    )!
    expect([
      idAt(w, 2, 0) & WHOLE_DOOR,
      idAt(w, 0, 2) & WHOLE_DOOR,
      idAt(w, 1, 2) & WHOLE_DOOR,
    ]).toEqual([0, 0, 0])
    expect([idAt(w, 2, 2), idAt(w, 0, 2)]).toEqual([0x108003, 3]) // 3 | the door-part id (1 << 15) | WHOLE_DOOR (1 << 20): pinned, not rebuilt from the constants
  })
  it('composed over a tile: solid cells stay full strength and door cells alternate', () => {
    const doors = spriteDoors({ ...G, sprites: [dto(ROPE)] }, 0)!
    const planes = {
      sprites2: compositeSpriteScreen([dto(ROPE)], 0, G)!,
      l1Low: new Uint8ClampedArray(W * 32 * 4).fill(255),
    }
    const flips = doorFlips({
      width: W,
      height: 32,
      planes: {},
      lists: { main: [], sub: [] },
      math: null,
      doors,
    })
    const out = composeScreen({
      ...G,
      planes,
      lists: { main: ['l1Low', 'sprites2'], sub: [] },
      math: null,
      doors,
      flips,
    })
    const solid = px(out, W, 0, 0)
    const cells = (y0: number) =>
      Array.from({ length: 64 }, (_, i) => px(out, W, i % 8, y0 + Math.floor(i / 8)).join())
    expect(new Set(cells(0))).toEqual(new Set([solid.join()]))
    expect(new Set(cells(16)).size).toBe(2) // full strength and dim squares
    expect(cells(16)).toContain(solid.join())
  })
  it('lands in a priority plane at every OAM priority, the door bit apart from it', () => {
    for (const pri of [0, 1, 2, 3]) {
      const plane = spritePlanes({ ...G, sprites: [dto(ROPE, pri)] }, 0)[SPRITE_KEYS[pri]!]
      expect(plane?.[(20 * W + 3) * 4 + 3], `priority ${pri}`).toBe(255)
    }
  })
  it('keeps the door squares past the map edge: the pad is dimmed on the door cells only', () => {
    const out = offMapSpritePixels(
      [dto(ROPE)],
      W,
      8,
      { left: 0, top: 0, right: 0, bottom: 32 },
      false,
    )!
    const alphas = (y0: number) =>
      new Set(
        Array.from({ length: 64 }, (_, i) => out[((y0 + Math.floor(i / 8)) * W + (i % 8)) * 4 + 3]),
      )
    expect([...alphas(8)]).toEqual([255])
    expect(alphas(16).size).toBe(2)
  })
})
