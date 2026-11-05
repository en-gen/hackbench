/**
 * #1097: the map view drew the Magikoopa ($1F) on the level's own row 15 because it took the CGRAM writes of the
 * FIRST drawn pass, the fade-in frame that runs before the first palette upload (SMWDisX bank_01.asm:8480 state 1,
 * upload at CODE_01C028 bank_01.asm:8733-8755). The game leaves the fade's last rung in CGRAM, columns 0-7 only.
 * Synthetic (CI has no ROM): the run is built here, with rung colors invented for this fixture, so what is asserted
 * is which pass's writes the view takes and that columns 8-15 keep the level's colors, not any ROM value.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'
import type {
  PassResult,
  SpriteModel,
  SpritePart,
} from '../../../src/rom/sprites/interp/SpriteRunner'
import {
  drawSprites,
  modelResult,
  type SpriteDrawer,
} from '../../../theia/extension/src/node/map-sprites'
import { COLORS } from '../support/mapInputs'

const ROW15 = 15 * 16
/** A fade rung: eight invented colors for CGRAM $F0..$F7, distinct per rung and per column. */
const rung = (k: number) => Array.from({ length: 8 }, (_, c) => ({ index: ROW15 + c, bgr555: 0x0421 * (k + 1) + c * 3 })) // prettier-ignore
const part = (): SpritePart => ({ oam: 0, char: 0, size: 8, palette: 15, priority: 2, flipX: false, flipY: false, dx: 0, dy: 0, attr: 0, ox: 0, oy: 0 }) // prettier-ignore
const pass = (n: number, parts: SpritePart[], palette: PassResult['palette']): PassResult => ({ pass: n, pos: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, parts, uploads: [], palette, }) // prettier-ignore

/** Fade-in draws on pass 1 before any upload; rungs 0..2 then land, cumulatively, as the runner reports them. */
const run = (id: number, rungs = 3): SpriteModel => ({
  id,
  anchor: { x: 0, y: 0, rawX: 0, rawY: 0 },
  chosen: 1,
  dependsOn: [],
  steps: [],
  passes: [
    pass(0, [], []),
    pass(1, [part()], []),
    ...Array.from({ length: rungs }, (_, k) => pass(k + 2, [part()], Array.from({ length: k + 1 }, (_, j) => rung(j)).flat())), // prettier-ignore
  ],
})

const s = { index: 0, x: 0, y: 0, spriteId: 0x1f, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as LevelSprite // prettier-ignore
/** Char 0: pixel 0 is color 3 (a column the upload writes), pixel 1 is color 10 (one it does not). */
const chars = { sp1: [Uint8Array.from([3, 10, ...new Array(62).fill(0)])] }
const px = (m: SpriteModel) => {
  const draw: SpriteDrawer = () => modelResult(m as never)
  const [d] = drawSprites([s], { vram: chars, colors: COLORS }, draw)
  const b = Buffer.from(d!.rgba, 'base64')
  return [0, 1].map(i => Array.from(b.subarray(i * 4, i * 4 + 4)))
}

describe('Magikoopa palette on the map (#1097)', () => {
  it('shows the fade rung that is left in CGRAM, not the level row and not an earlier rung', () => {
    const [written] = px(run(0x1f))
    expect(written).toEqual(bgr555ToRgba(rung(2)[3]!.bgr555))
  })

  it('composites: the columns the upload does not write keep the level row', () => {
    const [, kept] = px(run(0x1f))
    expect(kept).toEqual(COLORS[ROW15 + 10])
  })

  it('follows the cart: a shorter fade rests on its own last rung', () => {
    expect(px(run(0x1f, 1))[0]).toEqual(bgr555ToRgba(rung(0)[3]!.bgr555))
  })

  it('leaves every other sprite on the palette of its drawn pass', () => {
    // Same run under another id: its drawn pass (1) had written nothing, so the level row shows.
    expect(px(run(0xc5))[0]).toEqual(COLORS[ROW15 + 3])
  })
})
