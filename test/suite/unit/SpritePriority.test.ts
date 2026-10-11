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
import { composeScreen, type ScreenInput, type SourceKey } from '../../../src/rom/model/ColorMath'
import { screenPlanes } from '../../../src/rom/model/ScreenPlanes'
import { drawSprites, interpParts } from '../../../theia/extension/src/node/map-sprites'
import {
  decodeArts,
  IndicatorDisplay,
  spriteDoors,
  spritePlanes,
} from '../../../theia/extension/src/browser/map-view-model'
import { decodeRgba } from '../../../theia/extension/src/browser/map16-pixels'
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
  it('OBJ priority 0 and 1 under layer 2 draw in the door too (D52 part 2: the hardware order)', () => {
    for (const priority of [0, 1])
      for (const bg of ['l2Low', 'l2High'] as const) {
        const r = scene({ x: 10, y: 10, priority, bg, main: 0x12 })
        for (let y = 0; y < 8; y++)
          for (let x = 0; x < 8; x++)
            expect(at(r, x, y), `p${priority} ${bg} ${x},${y}`).toEqual(lerp([31, 32, 33], SPRITE_RGB, (x + y) % 2 === 0 ? 1 : HIDE)) // prettier-ignore
      }
  })
  it('OBJ priority 0 under layer 1 is covered and gets the door; priority 2 under layer 2 high too', () => {
    expect(at(scene({ x: 10, y: 10, priority: 0, bg: 'l1Low' }), 0, 1)).toEqual(
      lerp(L1_RGB, SPRITE_RGB, HIDE),
    )
    expect(at(scene({ x: 10, y: 10, priority: 2, bg: 'l2High', main: 0x12 }), 0, 1)).toEqual(lerp([31, 32, 33], SPRITE_RGB, HIDE)) // prettier-ignore
  })
})

describe('the door against an independent per-pixel oracle (D52, #795)', () => {
  const W = 32
  const HIDE = 0.25
  const L2_RGB = [31, 32, 33]
  const lerp = (tile: number[], sprite: number[], s: number) => tile.map((v, k) => Math.round(v * (1 - s) + sprite[k]! * s)) // prettier-ignore
  const maskTile = (on: (x: number, y: number) => boolean) => Uint8Array.from({ length: 64 }, (_, i) => (on(i % 8, i >> 3) ? 1 : 0)) // prettier-ignore
  type Spec = { x: number; y: number; char: number; flipX?: boolean; priority?: number }
  type Plane = 'l1High' | 'l1Low' | 'l2Low' | 'l3High'

  /** `specs` sprites (char n is tiles[n]) under the planes in `planes`, each covering where its function says. */
  function run(
    specs: Spec[],
    tiles: Uint8Array[],
    planes: Partial<Record<Plane, (x: number, y: number) => boolean>>,
    main = 0x17,
    opts: { bg3?: boolean; lists?: ScreenInput['lists']; math?: ScreenInput['math'] } = {},
  ) {
    // prettier-ignore
    const model = { vram: { sp1: tiles }, colors: COLORS }
    const sprites = specs.map((_, i) => ({ ...spr, index: i })) as LevelSprite[]
    const dtos = drawSprites(sprites, model, s => {
      const sp = specs[s.index]!
      return { ok: true, parts: interpParts([oam({ priority: sp.priority ?? 2, char: sp.char, flipX: sp.flipX ?? false })]), anchor: { x: sp.x, y: sp.y }, identity } // prettier-ignore
    }) // prettier-ignore
    const input: Partial<Record<SourceKey, Uint8ClampedArray | null>> = {}
    for (const [k, covers] of Object.entries(planes)) {
      const plane = new Uint8ClampedArray(W * W * 4)
      for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (covers(x, y)) plane.set([...(k.startsWith('l1') ? L1_RGB : k.startsWith('l3') ? L3_RGB : L2_RGB), 255], (y * W + x) * 4) // prettier-ignore
      input[k as SourceKey] = plane
    }
    const sp = { orientation: 'horizontal' as const, width: W, height: W, sprites: dtos }
    const out = composeScreen({ width: W, height: W, planes: { ...input, ...spritePlanes(sp, 0) }, doors: spriteDoors(sp, 0), lists: opts.lists ?? screenPlanes(main, 0x00, opts.bg3 ?? false), math: opts.math ?? null }) // prettier-ignore
    return { out, dtos }
  }

  /**
   * The expected composite of every on-screen pixel of every sprite, from the sprite's own bitmap and none
   * of the code under test: `tile(x, y)` is the covering plane color there (null: uncovered), the door
   * strength is the (lx + ly) parity on the bitmap, swapped when more covered pixels sit on the full
   * squares than on the dim ones.
   */
  function expectDoors(
    r: ReturnType<typeof run>,
    tile: (x: number, y: number) => number[] | null,
    label: string,
  ) {
    // prettier-ignore
    for (const [n, dto] of r.dtos.entries()) {
      const { x0, y0, x1, y1 } = dto.box
      const rgba = decodeRgba(dto.rgba)
      let full = 0
      let dim = 0
      const cells: [number, number, number[] | null][] = []
      for (let ly = 0; ly < y1 - y0; ly++)
        for (let lx = 0; lx < x1 - x0; lx++) {
          const [x, y] = [x0 + lx, y0 + ly]
          if (!rgba[(ly * (x1 - x0) + lx) * 4 + 3] || x < 0 || y < 0 || x >= W || y >= W) continue
          const t = tile(x, y)
          cells.push([lx, ly, t])
          if (t && (lx + ly) % 2 === 0) full++
          else if (t) dim++
        }
      const flip = full > dim
      expect(cells.length, `${label} sprite ${n} draws something on screen`).toBeGreaterThan(0)
      for (const [lx, ly, t] of cells) {
        const got = px(r.out, W, x0 + lx, y0 + ly).slice(0, 3)
        const strength = ((lx + ly) % 2 === 0) !== flip ? 1 : HIDE
        expect(got, `${label} sprite ${n} pixel ${lx},${ly} at ${x0 + lx},${y0 + ly}`).toEqual(t ? lerp(t, SPRITE_RGB, strength) : SPRITE_RGB) // prettier-ignore
      }
    }
  }
  const SOLID = new Uint8Array(64).fill(1)

  it('two sprites with different swap decisions, each decided on its own covered pixels', () => {
    const fullOnly = maskTile((x, y) => (x + y) % 2 === 0)
    const dimMajor = maskTile((x, y) => (x + y) % 2 === 1 || x === 0)
    for (const flipX of [false, true]) {
      const r = run([{ x: 4, y: 5, char: 0 }, { x: 18, y: 17, char: 1, flipX }], [fullOnly, dimMajor], { l1High: () => true }) // prettier-ignore
      expectDoors(r, () => L1_RGB, `flipX ${flipX}`)
    }
  })

  it('the swap is per sprite, not one shared flip: a full-squares-only sprite swaps, a solid one does not', () => {
    const r = run([{ x: 4, y: 4, char: 0 }, { x: 18, y: 18, char: 1 }], [maskTile((x, y) => (x + y) % 2 === 0), SOLID], { l1High: () => true }) // prettier-ignore
    expect(px(r.out, W, 4, 4).slice(0, 3)).toEqual(lerp(L1_RGB, SPRITE_RGB, HIDE))
    expect(px(r.out, W, 18, 18).slice(0, 3)).toEqual(lerp(L1_RGB, SPRITE_RGB, 1))
  })

  it('a sprite at every screen edge offset, covered by a full layer 1 plane', () => {
    for (let o = -7; o < W; o++) {
      expectDoors(
        run([{ x: o, y: 9, char: 0 }], [SOLID], { l1High: () => true }),
        () => L1_RGB,
        `x ${o}`,
      )
      expectDoors(
        run([{ x: 9, y: o, char: 0 }], [SOLID], { l1High: () => true }),
        () => L1_RGB,
        `y ${o}`,
      )
    }
  })

  it('the last column and row take the door, and a cut sprite decides its swap on the pixels on screen', () => {
    const half = maskTile((x, y) => (x + y) % 2 === 0 || x < 3)
    for (const [x, y] of [
      [W - 8, W - 8],
      [W - 3, W - 5],
      [W - 1, 4],
      [4, W - 1],
    ] as const) {
      const r = run([{ x, y, char: 0 }], [half], { l1High: () => true })
      expectDoors(r, () => L1_RGB, `edge ${x},${y}`)
      expect(px(r.out, W, Math.min(W - 1, x + 7), Math.min(W - 1, y + 7)).slice(0, 3), `edge ${x},${y} corner`).not.toEqual(SPRITE_RGB) // prettier-ignore
    }
  })

  it('a partly covered sprite with unequal full and dim counts: the swap follows the covered pixels only', () => {
    // Uncovered left (x < 3) is drawn on the dim squares only (12 pixels); the covered part has 5 pixels on the
    // full squares and 1 on a dim one. Counted over the covered part the sprite swaps; counted over every
    // pixel (full 5, dim 13) it would not.
    const tile = maskTile((x, y) => (x < 3 && (x + y) % 2 === 1) || (x >= 3 && y < 2 && ((x + y) % 2 === 0 || (x === 3 && y === 0)))) // prettier-ignore
    for (const [x, y] of [
      [10, 10],
      [11, 10],
      [10, 11],
      [11, 11],
    ] as const) {
      const r = run([{ x, y, char: 0 }], [tile], { l1High: cx => cx >= x + 3 })
      expectDoors(r, cx => (cx >= x + 3 ? L1_RGB : null), `shift ${x},${y}`)
    }
  })

  it('a later sprite transparent pixel does not take over an earlier sprite door id', () => {
    // A is solid at (10, 10); B at (11, 10) is transparent except one odd-parity pixel (the count must not tie). Pixel (11, 10) is A's local (1, 0): dim.
    const r = run([{ x: 10, y: 10, char: 0 }, { x: 11, y: 10, char: 1 }], [SOLID, maskTile((x, y) => x === 7 && y === 6)], { l1High: () => true }) // prettier-ignore
    expect(px(r.out, W, 11, 10).slice(0, 3)).toEqual(lerp(L1_RGB, SPRITE_RGB, HIDE))
    expectDoors(r, () => L1_RGB, 'transparent overlap')
  })

  it('a priority 2 sprite under an opaque layer 3 priority tile takes the door', () => {
    const r = run([{ x: 10, y: 10, char: 0, priority: 2 }], [SOLID], { l3High: () => true }, 0x15, { bg3: true }) // prettier-ignore
    expectDoors(r, () => L3_RGB, 'l3High')
    expect(px(r.out, W, 10, 11).slice(0, 3)).toEqual(lerp(L3_RGB, SPRITE_RGB, HIDE))
  })

  it('the door is main screen only: a sprite under a sub screen plane gets none', () => {
    const to8 = (c: number) => ((c >> 3) << 3) | (c >> 5)
    const lists = { main: ['l1Low'] as SourceKey[], sub: ['sprites2', 'l2Low'] as SourceKey[] }
    // Colour math adds the sub screen to the empty main screen (CGADSUB $20: the backdrop adds), so the
    // output is the sub screen's top pixel: layer 2 over the sprite, no door, in 5-bit colour.
    const r = run([{ x: 10, y: 10, char: 0 }], [SOLID], { l2Low: () => true }, 0x17, { lists, math: { cgadsub: 0x20, fixed: [0, 0, 0] } }) // prettier-ignore
    for (let y = 10; y < 18; y++)
      for (let x = 10; x < 18; x++)
        expect(px(r.out, W, x, y).slice(0, 3), `${x},${y}`).toEqual(L2_RGB.map(to8))
  })

  it('stacked layer 2 and layer 1 low planes over a priority 0 sprite: the door shows the nearer one', () => {
    const at0 = [{ x: 10, y: 10, char: 0, priority: 0 }]
    expectDoors(
      run(at0, [SOLID], { l2Low: () => true, l1Low: () => true }),
      () => L1_RGB,
      'l2Low+l1Low',
    )
    expectDoors(run(at0, [SOLID], { l2Low: () => true }), () => L2_RGB, 'l2Low')
  })
})

describe('IndicatorDisplay keeps the sprite door under an indicator cell (D52, #795)', () => {
  const W = 32
  const G32 = { orientation: 'horizontal' as const, width: W, height: W }
  const ART = decodeArts({ a: Buffer.from(new Uint8Array(16 * 16 * 4).map((_, i) => (i % 4 === 0 ? 200 : i % 4 === 3 ? 255 : 0))).toString('base64') }) // prettier-ignore
  // Sprite 0 straddles the indicator cell's edge (x 12..19, the cell ends at 16): its columns 0..3 in the cell
  // hold 8 dim-square pixels, its columns 4..7 outside hold 16 full-square ones. The whole sprite swaps; the
  // cell's pixels alone would not. Sprite 1 is solid.
  const tiles = [Uint8Array.from({ length: 64 }, (_, i) => { const [x, y] = [i % 8, i >> 3]; return (x < 4 && y < 4 && (x + y) % 2 === 1) || (x >= 4 && (x + y) % 2 === 0) ? 1 : 0 }), new Uint8Array(64).fill(1)] // prettier-ignore
  const lerp = (t: number[], s: number[], a: number) => t.map((v, k) => Math.round(v * (1 - a) + s[k]! * a)) // prettier-ignore
  const specs = [
    { x: 12, y: 5 },
    { x: 20, y: 6 },
  ]
  const dtos = drawSprites(specs.map((_, i) => ({ ...spr, index: i })) as LevelSprite[], { vram: { sp1: tiles }, colors: COLORS }, s => ({ ok: true, parts: interpParts([oam({ char: s.index })]), anchor: specs[s.index]!, identity })) // prettier-ignore
  const sp = { ...G32, sprites: dtos }
  const covered = (x: number) => x >= 8 // layer 1 high covers both sprites
  const l1 = new Uint8ClampedArray(W * W * 4)
  for (let y = 0; y < W; y++) for (let x = 0; x < W; x++) if (covered(x)) l1.set([...L1_RGB, 255], (y * W + x) * 4) // prettier-ignore
  const planes = { l1High: l1, l2Low: null, ...spritePlanes(sp, 0) }
  const lists = screenPlanes(0x17, 0x00, false)
  const base = composeScreen({ width: W, height: W, planes, lists, math: null, doors: spriteDoors(sp, 0) }) // prettier-ignore

  for (const zoom of [1, 2, 3]) {
    it(`zoom ${zoom}: every sprite pixel in the cell is the native composite's, door included`, () => {
      // Indicator on layer 2 low at the cell (0, 0) .. (16, 16): it lies under sprite 0 and layer 1 high.
      const d = new IndicatorDisplay({ width: W, height: W, zoom, screen: 0, geometry: G32, planes, lists, math: null, base, indicators: [{ plane: 'l2Low', x: 0, y: 0, art: 'a' }], arts: ART, doors: spriteDoors(sp, 0) }) // prettier-ignore
      expect(d.touches).toBe(true)
      let doorPixels = 0
      for (const dto of dtos.slice(0, 1)) {
        const { x0, y0, x1, y1 } = dto.box
        for (let y = y0; y < y1; y++)
          for (let x = x0; x < x1; x++) {
            if (!px(base, W, x, y)[3]) continue
            const want = px(base, W, x, y)
            if (covered(x)) doorPixels++
            for (let dy = 0; dy < zoom; dy++)
              for (let dx = 0; dx < zoom; dx++)
                expect(px(d.image, d.width, x * zoom + dx, y * zoom + dy), `native ${x},${y}`).toEqual(want) // prettier-ignore
          }
      }
      expect(doorPixels, 'the cell has door pixels to compare').toBeGreaterThan(0)
      // The swap puts the sprite's dim-square pixel (local 1, 0) at full strength only if the whole sprite decides.
      expect(px(base, W, 13, 5).slice(0, 3)).toEqual(lerp(L1_RGB, SPRITE_RGB, 1))
    })
  }
})
