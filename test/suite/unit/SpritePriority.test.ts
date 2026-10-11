/**
 * Sprite OAM priority in the map view (#795). Each OBJ pixel keeps its OAM
 * priority (PP, attribute bits 5:4) and is composited at that priority's mode 1
 * slot (docs/rom/obj-priority.md section 1). The whole served path runs on
 * synthetic data, no ROM: interpreter parts -> `drawSprites` -> the browser's
 * per-screen cut -> `composeScreen` over `screenPlanes` lists.
 */
import { describe, it, expect } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import type { SpritePart } from '../../../src/rom/sprites/interp/SpriteRunner'
import { composeScreen, type SourceKey } from '../../../src/rom/model/ColorMath'
import { screenPlanes } from '../../../src/rom/model/ScreenPlanes'
import { drawSprites, interpParts } from '../../../theia/extension/src/node/map-sprites'
import { spritePlanes } from '../../../theia/extension/src/browser/map-view-model'
import { COLORS, px } from '../support/mapInputs'

/** OBJ char $400: solid color 1. */
const MODEL = { vram: { sp1: [new Uint8Array(64).fill(1)] }, colors: COLORS }
const SPRITE_RGB = [0x91, 100, 200]
const L1_RGB = [7, 8, 9]
const G = { orientation: 'horizontal' as const, width: 16, height: 16 }
const spr = { index: 0, x: 0, y: 0, spriteId: 0x10, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as unknown as LevelSprite // prettier-ignore
const oam = (o: Partial<SpritePart>): SpritePart => ({ oam: 0, char: 0, size: 8, palette: 9, priority: 2, flipX: false, flipY: false, dx: 0, dy: 0, attr: 0, ox: 0, oy: 0, ...o }) // prettier-ignore
const identity = { spriteId: 0x10, mainHandler: 0, initHandler: 0, status: 'vanilla' as const }

/** The pixel (2, 2) of one screen: the sprite's parts over one opaque L1 pixel in `l1`. */
function pixel(parts: SpritePart[], l1: 'l1Low' | 'l1High', bg3Priority = false): number[] {
  const [dto] = drawSprites([spr], MODEL, () => ({ ok: true, parts: interpParts(parts), anchor: { x: 0, y: 0 }, identity })) // prettier-ignore
  const bg = new Uint8ClampedArray(16 * 16 * 4)
  bg.set([...L1_RGB, 255], (2 * 16 + 2) * 4)
  const planes: Partial<Record<SourceKey, Uint8ClampedArray | null>> = { [l1]: bg, ...spritePlanes({ ...G, sprites: [dto!] }, 0) } // prettier-ignore
  // Main screen BG1 and OBJ, as level mode 0 designates (bank_05.asm:480-504).
  const out = composeScreen({ width: 16, height: 16, planes, lists: screenPlanes(0x11, 0x00, bg3Priority), math: null }) // prettier-ignore
  return px(out, 16, 2, 2).slice(0, 3)
}

describe('each OAM priority against layer 1 low and priority tiles (mode 1)', () => {
  // OBJ.0 and OBJ.1 sit under BG1.0; OBJ.2 between BG1.0 and BG1.1; OBJ.3 over BG1.1.
  const want = {
    l1Low: [L1_RGB, L1_RGB, SPRITE_RGB, SPRITE_RGB],
    l1High: [L1_RGB, L1_RGB, L1_RGB, SPRITE_RGB],
  }
  for (const bg3 of [false, true]) {
    for (const l1 of ['l1Low', 'l1High'] as const) {
      for (const p of [0, 1, 2, 3]) {
        it(`priority ${p} against ${l1}, BG3 priority bit ${+bg3}`, () => {
          expect(pixel([oam({ priority: p })], l1, bg3)).toEqual(want[l1][p])
        })
      }
    }
  }
})

describe('OBJ against OBJ: the lower OAM index wins the pixel, then its own priority meets the BG', () => {
  it('a low-index priority 0 part hides a priority 3 part under it, and goes behind layer 1 low', () => {
    const parts = [oam({ oam: 4, priority: 3 }), oam({ oam: 1, priority: 0 })]
    expect(pixel(parts, 'l1Low')).toEqual(L1_RGB)
  })
  it('the same pair with the indices swapped shows the priority 3 part over layer 1 priority', () => {
    const parts = [oam({ oam: 1, priority: 3 }), oam({ oam: 4, priority: 0 })]
    expect(pixel(parts, 'l1High')).toEqual(SPRITE_RGB)
  })
})

describe('spritePlanes', () => {
  it('a placeholder, which has no OAM entry, keeps the pre-#795 slot (priority 2)', () => {
    const [dto] = drawSprites([spr], MODEL, () => ({ ok: false, reason: 'refused' }))
    const p = spritePlanes({ ...G, sprites: [dto!] }, 0)
    expect([p.sprites0, p.sprites1, p.sprites3]).toEqual([null, null, null])
    expect(px(p.sprites2!, 16, 0, 0)[3]).toBe(255)
  })
  it('is all null when no sprite reaches the screen, or none were read', () => {
    const none = { sprites0: null, sprites1: null, sprites2: null, sprites3: null }
    expect(spritePlanes({ ...G, sprites: [] }, 0)).toEqual(none)
    expect(spritePlanes(undefined, 0)).toEqual(none)
  })
})
