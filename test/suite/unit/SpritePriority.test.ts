/**
 * Sprite OAM priority in the map view (#795). Each OBJ pixel keeps its OAM
 * priority (PP, attribute bits 5:4) and is composited at that priority's mode 1
 * slot (docs/rom/obj-priority.md section 1). The whole served path runs on
 * synthetic data, no ROM: interpreter parts -> `drawSprites` -> the browser's
 * per-screen cut -> `composeScreen` over `screenPlanes` lists.
 */
import { describe, it, expect } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { runSprite, type SpritePart } from '../../../src/rom/sprites/interp/SpriteRunner'
import { composeScreen, type SourceKey } from '../../../src/rom/model/ColorMath'
import { screenPlanes } from '../../../src/rom/model/ScreenPlanes'
import { drawSprites, interpParts } from '../../../theia/extension/src/node/map-sprites'
import { spriteDoors, spritePlanes } from '../../../theia/extension/src/browser/map-view-model'
import { COLORS, px } from '../support/mapInputs'
import { buildSyntheticRom } from '../support/syntheticSpriteRom'

/** OBJ char $400: solid color 1. */
const MODEL = { vram: { sp1: [new Uint8Array(64).fill(1)] }, colors: COLORS }
const SPRITE_RGB = [0x91, 100, 200]
const L1_RGB = [7, 8, 9]
const L3_RGB = [17, 18, 19]
const G = { orientation: 'horizontal' as const, width: 16, height: 16 }
const spr = { index: 0, x: 0, y: 0, spriteId: 0x10, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as unknown as LevelSprite // prettier-ignore
const oam = (o: Partial<SpritePart>): SpritePart => ({ oam: 0, char: 0, size: 8, palette: 9, priority: 2, flipX: false, flipY: false, dx: 0, dy: 0, attr: 0, ox: 0, oy: 0, ...o }) // prettier-ignore
const identity = { spriteId: 0x10, mainHandler: 0, initHandler: 0, status: 'vanilla' as const }

type Bg = 'l1Low' | 'l1High' | 'l3Low' | 'l3High'

/** The pixel (2, 2) of one screen: the sprite's parts over one opaque pixel in the BG plane `bg`. */
function pixel(parts: SpritePart[], bg: Bg, bg3Priority = false): number[] {
  const [dto] = drawSprites([spr], MODEL, () => ({ ok: true, parts: interpParts(parts), anchor: { x: 0, y: 0 }, identity })) // prettier-ignore
  const plane = new Uint8ClampedArray(16 * 16 * 4)
  plane.set([...(bg.startsWith('l1') ? L1_RGB : L3_RGB), 255], (2 * 16 + 2) * 4)
  const planes: Partial<Record<SourceKey, Uint8ClampedArray | null>> = { [bg]: plane, ...spritePlanes({ ...G, sprites: [dto!] }, 0) } // prettier-ignore
  // Main screen BG1, BG3 and OBJ: level mode 0's LevMainScrnTbl entry $15 (bank_05.asm:486).
  const out = composeScreen({ width: 16, height: 16, planes, lists: screenPlanes(0x15, 0x00, bg3Priority), math: null }) // prettier-ignore
  return px(out, 16, 2, 2).slice(0, 3)
}

describe('each OAM priority against layer 1 and layer 3 low and priority tiles (mode 1, level mode 0)', () => {
  const [L1, L3, S] = [L1_RGB, L3_RGB, SPRITE_RGB]
  // OBJ.0 and OBJ.1 sit under BG1.0; OBJ.2 between BG1.0 and BG1.1; OBJ.3 over BG1.1. Every OBJ is over
  // BG3.0. BG3.1 is over every OBJ with the BG3 bit set, and between OBJ.0 and OBJ.1 with it clear.
  const want: Record<Bg, [number[][], number[][]]> = {
    l1Low: [[L1, L1, S, S], [L1, L1, S, S]],
    l1High: [[L1, L1, L1, S], [L1, L1, L1, S]],
    l3Low: [[S, S, S, S], [S, S, S, S]],
    l3High: [[L3, S, S, S], [L3, L3, L3, L3]],
  } // prettier-ignore
  for (const bg3 of [false, true]) {
    for (const bg of ['l1Low', 'l1High', 'l3Low', 'l3High'] as const) {
      for (const p of [0, 1, 2, 3]) {
        it(`priority ${p} against ${bg}, BG3 priority bit ${+bg3}`, () => {
          expect(pixel([oam({ priority: p })], bg, bg3)).toEqual(want[bg][+bg3]![p])
        })
      }
    }
  }
})

describe('the priority read off the OAM attribute byte (synthetic cart, no ROM)', () => {
  // Id 0's MAIN stores attribute $0A (LDA #$0A : STA $0303,Y); the operand is replaced per case.
  const ATTR = [0xa9, 0x0a, 0x99, 0x03, 0x03]
  for (const [attr, want] of [
    [0x0a, 0],
    [0x1a, 1],
    [0x2a, 2],
    [0x3a, 3],
  ] as const) {
    it(`attribute $${attr.toString(16).toUpperCase()} draws at priority ${want}`, () => {
      const rom = buildSyntheticRom()
      const code = Array.from(rom.readAt(0x018640, 0x40)!)
      const at = code.findIndex((_, i) => ATTR.every((b, k) => code[i + k] === b))
      expect(at).toBeGreaterThanOrEqual(0)
      rom.writeAt(0x018640 + at + 1, [attr])
      const parts = runSprite(rom, 0).passes[0]!.parts
      expect(parts.map(p => p.priority)).toEqual([want])
      expect(interpParts(parts).map(p => p.priority)).toEqual([want, want, want, want])
    })
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

describe('a sprite pixel a tile covers draws through it in the hidden-tile screen door (D52, #795)', () => {
  const HIDE = 0.25
  const SIZE = 32
  const lerp = (tile: number[], sprite: number[], s: number) => tile.map((v, k) => Math.round(v * (1 - s) + sprite[k]! * s)) // prettier-ignore
  /** An 8x8 tile of color 1 where `on(x, y)`, else transparent. */
  const tileOf = (on: (x: number, y: number) => boolean) => ({ vram: { sp1: [Uint8Array.from({ length: 64 }, (_, i) => (on(i % 8, i >> 3) ? 1 : 0))] }, colors: COLORS }) // prettier-ignore

  /** One 8x8 sprite at (x, y) under `bg` plane cells chosen by `covers`: the composite and the sprite's box. */
  function scene(opts: {
    x: number
    y: number
    priority?: number
    bg: Bg | 'l2Low' | 'l2High'
    covers?: (x: number, y: number) => boolean
    on?: (x: number, y: number) => boolean
    main?: number
  }) {
    // prettier-ignore
    const model = opts.on ? tileOf(opts.on) : MODEL
    const sprite = { ...spr, x: 0, y: 0 }
    const [dto] = drawSprites([sprite], model, () => ({ ok: true, parts: interpParts([oam({ priority: opts.priority ?? 2 })]), anchor: { x: opts.x, y: opts.y }, identity })) // prettier-ignore
    const plane = new Uint8ClampedArray(SIZE * SIZE * 4)
    for (let y = 0; y < SIZE; y++) for (let x = 0; x < SIZE; x++) if (!opts.covers || opts.covers(x, y)) plane.set([...(opts.bg.startsWith('l1') ? L1_RGB : opts.bg.startsWith('l2') ? [31, 32, 33] : L3_RGB), 255], (y * SIZE + x) * 4) // prettier-ignore
    const sp = { orientation: 'horizontal' as const, width: SIZE, height: SIZE, sprites: [dto!] }
    const out = composeScreen({ width: SIZE, height: SIZE, planes: { [opts.bg]: plane, ...spritePlanes(sp, 0) }, doors: spriteDoors(sp, 0), lists: screenPlanes(opts.main ?? 0x15, 0x00, false), math: null }) // prettier-ignore
    return { out, box: dto!.box }
  }
  const at = (r: ReturnType<typeof scene>, x: number, y: number) =>
    px(r.out, SIZE, r.box.x0 + x, r.box.y0 + y).slice(0, 3)

  it('a fully covered sprite: half its pixels at full strength, half at 25%, on its own pixel grid', () => {
    for (let ox = 0; ox < 8; ox++) {
      for (let oy = 0; oy < 8; oy++) {
        const r = scene({ x: 8 + ox, y: 8 + oy, bg: 'l1High' })
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            expect(at(r, x, y), `offset ${ox},${oy} pixel ${x},${y}`).toEqual(lerp(L1_RGB, SPRITE_RGB, (x + y) % 2 === 0 ? 1 : HIDE)) // prettier-ignore
      }
    }
  })
  it('the parity flip: a sprite drawn only on the full-strength squares comes out dim, as a ghost tile does', () => {
    const r = scene({ x: 9, y: 11, bg: 'l1High', on: (x, y) => (x + y) % 2 === 0 })
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++)
        if ((x + y) % 2 === 0) expect(at(r, x, y)).toEqual(lerp(L1_RGB, SPRITE_RGB, HIDE))
        else expect(at(r, x, y)).toEqual(L1_RGB)
  })
  it('a dim-majority sprite keeps the squares (no flip)', () => {
    const r = scene({ x: 9, y: 11, bg: 'l1High', on: (x, y) => (x + y) % 2 === 1 })
    for (let y = 0; y < 8; y++)
      for (let x = 0; x < 8; x++)
        if ((x + y) % 2 === 1) expect(at(r, x, y)).toEqual(lerp(L1_RGB, SPRITE_RGB, HIDE))
  })
  it('a partly covered sprite: only the covered pixels change, the rest are the sprite exactly', () => {
    for (let ox = 0; ox < 8; ox++) {
      const [x0, y0] = [8 + ox, 10]
      const r = scene({ x: x0, y: y0, bg: 'l1High', covers: x => x >= x0 + 4 })
      for (let y = 0; y < 8; y++)
        for (let x = 0; x < 8; x++)
          expect(at(r, x, y), `offset ${ox} pixel ${x},${y}`).toEqual(x < 4 ? SPRITE_RGB : lerp(L1_RGB, SPRITE_RGB, (x + y) % 2 === 0 ? 1 : HIDE)) // prettier-ignore
    }
  })
  it('an uncovered sprite is unchanged', () => {
    const r = scene({ x: 10, y: 10, bg: 'l1Low' })
    for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) expect(at(r, x, y)).toEqual(SPRITE_RGB)
  })
  it('OBJ priority 0 and 1 under layer 2 stay hidden (D52 part 2, undecided)', () => {
    for (const priority of [0, 1])
      for (const bg of ['l2Low', 'l2High'] as const) {
        const r = scene({ x: 10, y: 10, priority, bg, main: 0x12 })
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            expect(at(r, x, y), `p${priority} ${bg} ${x},${y}`).toEqual([31, 32, 33])
      }
  })
  it('OBJ priority 0 under layer 1 is covered and gets the door; priority 2 under layer 2 high too', () => {
    expect(at(scene({ x: 10, y: 10, priority: 0, bg: 'l1Low' }), 0, 1)).toEqual(
      lerp(L1_RGB, SPRITE_RGB, HIDE),
    )
    expect(at(scene({ x: 10, y: 10, priority: 2, bg: 'l2High', main: 0x12 }), 0, 1)).toEqual(lerp([31, 32, 33], SPRITE_RGB, HIDE)) // prettier-ignore
  })
})
