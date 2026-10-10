/**
 * The map tab's sprite layer draws from the interpreter (#585, step 3 of
 * #582): `interpParts` / `modelResult` / `cameraFor` are synthetic (CI has no
 * ROM); the corpus block runs the real thing over vanilla maps and lays it
 * beside the table engine, which stays only as that oracle until step 4 (it
 * is not the served path).
 */
import { createHash } from 'crypto'
import { describe, it, expect } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { parseLevelSprites } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { loadLevelState } from '../../../src/rom/sprites/interp/LevelLoader'
import { runOnce } from '../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed, type SpriteSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import { readMarioStartPos } from '../../../src/rom/L3Loader'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import type { SpriteModel, SpritePart } from '../../../src/rom/sprites/interp/SpriteRunner'
import {
  cameraFor,
  drawSprites,
  engineDrawer,
  interpDrawer,
  interpParts,
  mapSprites,
  spriteLayer,
  modelResult,
  partKey,
  type SpriteDrawer,
} from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { COLORS } from '../support/mapInputs'

const part = (o: Partial<SpritePart>): SpritePart => ({ oam: 0, char: 0, size: 8, palette: 9, priority: 2, flipX: false, flipY: false, dx: 0, dy: 0, attr: 0, ox: 0, oy: 0, ...o }) // prettier-ignore
const model = (o: Partial<SpriteModel>): SpriteModel => ({ id: 1, passes: [], dependsOn: [], steps: [], ...o }) // prettier-ignore

describe('interpParts', () => {
  it('draws a 16 x 16 entry as four chars (tile, +1, +$10, +$11) and an 8 x 8 as one, at $400 + char', () => {
    const got = interpParts([part({ char: 0x20, size: 16, dx: -4, dy: -8 }), part({ oam: 1, char: 0x7, dx: 3, dy: 1 })]) // prettier-ignore
    const key = (c: number, dx: number, dy: number) => ({ charNum: c, dx, dy })
    expect(got.map(p => key(p.charNum, p.dx, p.dy))).toEqual([
      key(0x407, 3, 1),
      key(0x420, -4, -8),
      key(0x421, 4, -8),
      key(0x430, -4, 0),
      key(0x431, 4, 0),
    ])
  })

  it('a flip swaps which char of a 16 x 16 entry lands where, and the name table bit reaches $500', () => {
    const got = interpParts([part({ char: 0x100, size: 16, flipX: true, flipY: true })])
    const at = (dx: number, dy: number) => got.find(p => p.dx === dx && p.dy === dy)!.charNum
    // flipX + flipY: the bottom-right char sits top-left.
    expect([at(0, 0), at(8, 0), at(0, 8), at(8, 8)]).toEqual([0x511, 0x510, 0x501, 0x500])
    expect(got.every(p => p.flipX && p.flipY)).toBe(true)
  })

  it('wraps the neighbour chars like the PPU: column in the low nibble, row in the 256-char table, bit 8 kept', () => {
    const at = (char: number) => interpParts([part({ char, size: 16 })]).map(p => p.charNum - 0x400).sort((a, b) => a - b) // prettier-ignore
    expect(at(0x1f)).toEqual([0x10, 0x1f, 0x20, 0x2f]) // $1F, $10, $2F, $20
    expect(at(0xf0)).toEqual([0x00, 0x01, 0xf0, 0xf1]) // $F0, $F1, $00, $01
    expect(at(0x1ff)).toEqual([0x100, 0x10f, 0x1f0, 0x1ff]) // bit 8 unchanged: $1FF, $1F0, $10F, $100
  })

  it('puts the lower OAM index last, so it wins an overlap when blitted in order', () => {
    expect(interpParts([part({ oam: 2, char: 1 }), part({ oam: 0, char: 2 })]).map(p => p.charNum)).toEqual([0x401, 0x402]) // prettier-ignore
  })
})

describe('modelResult', () => {
  it('serves the chosen pass at the anchor INIT left, and says why when there is nothing to draw', () => {
    const passes = [
      { pass: 0, pos: { x: 0, y: 0 }, parts: [], uploads: [], palette: [] },
      { pass: 1, pos: { x: 0, y: 0 }, parts: [part({ char: 5, dx: 2 })], uploads: [], palette: [] },
      { pass: 2, pos: { x: 0, y: 0 }, parts: [part({ char: 9 })], uploads: [], palette: [] },
    ]
    const r = modelResult(
      model({ anchor: { x: 104, y: 51, rawX: 96, rawY: 52 }, passes, chosen: 1 }),
    )
    expect(r).toMatchObject({ ok: true, anchor: { x: 104, y: 51 } })
    expect(r.ok && r.parts.map(p => p.charNum)).toEqual([0x405])
    expect(modelResult(model({ refusal: 'step budget spent' }))).toEqual({ ok: false, reason: 'refused: step budget spent' }) // prettier-ignore
    expect(modelResult(model({ emptyReason: 'drew no OAM tile' }))).toEqual({ ok: false, reason: 'drew no OAM tile' }) // prettier-ignore
  })
})

describe('modelResult unverified', () => {
  const drawn = { anchor: { x: 1, y: 1, rawX: 1, rawY: 1 }, passes: [{ pass: 0, pos: { x: 0, y: 0 }, parts: [part({})], uploads: [], palette: [] }], chosen: 0 } // prettier-ignore
  it('is unverified exactly when the model says its seed was generic', () => {
    const g = modelResult(model({ ...drawn, seedSource: 'generic', seedReason: 'no stock loader' }))
    expect(g).toMatchObject({ ok: true, unverified: 'level loader refused (no stock loader); drawn from a placement-only seed' }) // prettier-ignore
    expect('unverified' in modelResult(model({ ...drawn, seedSource: 'rom-level-load' }))).toBe(
      false,
    )
    expect('unverified' in modelResult(model(drawn))).toBe(false)
  })
})

describe('cameraFor', () => {
  it('centres the sprite and clamps to the scroll range, horizontal and vertical', () => {
    expect(cameraFor(1000, 300, false, 20)).toEqual({ x: 872, y: 188 })
    expect(cameraFor(10, 10, false, 20)).toEqual({ x: 0, y: 0 })
    expect(cameraFor(9000, 430, false, 20)).toEqual({ x: 4864, y: 208 })
    expect(cameraFor(500, 700, true, 3)).toEqual({ x: 256, y: 544 })
  })
})

describe('screen-fixed parts (#286)', () => {
  // The loader left Layer 1 at (0, 192), as Yoshi's House ($104) does at load; OAM 3, 6 and 7 hold residue.
  const loader = (cam = [0, 0, 0xc0, 0]) => {
    const loaded = new Uint8Array(0x2000)
    cam.forEach((v, i) => (loaded[0x1a + i] = v)) // $1A $1B $1C $1D, as the loader left Layer 1
    for (const [oam, x, y] of [[3, 16, 48], [6, 70, 60], [7, 90, 50]]) loaded.set([x!, y!], 0x200 + oam! * 4) // prettier-ignore
    return withSeed({ loaded })
  }
  const blank = RomFile.fromBytes('blank.sfc', Buffer.alloc(0x80000))
  const at = (x: number, y: number) => ({ index: 0, x: x / 16, y: y / 16, spriteId: 0x8c, screen: 0, extraBit: false, raw: [], streamOffset: 0 }) as LevelSprite // prettier-ignore
  const s8 = (v: number) => (((v & 0xff) + 128) & 0xff) - 128
  type Cam = { x: number; y: number }
  type Run = (r: RomFile, i: number, s: SpriteSeed) => SpriteModel
  /** A run like the runner's: the anchor is the sprite; `parts(cam)` lists [oam, ox, oy]; they are pass `chosen` of `mainPasses`. */
  const runOf =
    (parts: (cam: Cam) => number[][], chosen = 0): Run =>
    (_r, _i, seed) => {
      const { camera: cam, sprite: sp } = seed
      const mk = ([oam, ox, oy]: number[]) => part({ oam: oam!, ox: ox!, oy: oy!, dx: ox! - (sp.x - cam.x), dy: s8(oy! - (sp.y - cam.y)) }) // prettier-ignore
      const passes = Array.from({ length: seed.mainPasses }, (_, pass) => ({ pass, pos: { x: 0, y: 0 }, parts: pass === chosen ? parts(cam).map(mk) : [], uploads: [], palette: [] })) // prettier-ignore
      return model({ anchor: { x: sp.x, y: sp.y, rawX: sp.x, rawY: sp.y }, passes, chosen })
    }
  const draw = (s: LevelSprite, run: Run, o: { cam?: number[]; vertical?: boolean } = {}) => interpDrawer(blank, 0x104, { isVertical: !!o.vertical, screenCount: 2 }, run, () => loader(o.cam))(s) // prettier-ignore
  const dxy = (r: ReturnType<SpriteDrawer>) => (r.ok ? r.parts.map(p => [p.dx, p.dy]) : r) // highest OAM first
  // One part ignores the camera (OAM 184,176, as CODE_02F4EB writes, bank_02.asm:15531-15576), one follows it.
  const flame = (c: Cam) => [[0, 184, 176], [1, 132 - c.x, 120 - c.y]] // prettier-ignore

  it('places a part whose OAM ignores the camera at OAM + the loader camera, unwrapped; a camera-relative part stays', () => {
    const r = draw(at(128, 112), runOf(flame))
    expect(dxy(r)).toEqual([[4, 8], [56, 256]]) // prettier-ignore
    // Map position of the fixed part: anchor + offset = (184, 368), inside the fireplace.
    expect(r.ok && [128 + r.parts[1]!.dx, 112 + r.parts[1]!.dy]).toEqual([184, 368])
  })

  it('calls a part fixed only when OAM index, X and Y all match the probe; following either axis alone is not', () => {
    // OAM 1 follows Y only, 2 follows X only, 4/5 swap index with the camera (same X, Y); OAM 0 is the fixed one.
    const parts = (c: Cam) => [[0, 184, 176], [1, 200, 100 - c.y], [2, 90 - c.x, 100], [4 + (c.x & 1), 40, 40]] // prettier-ignore
    expect(dxy(draw(at(128, 112), runOf(parts)))).toEqual([[-88, -72], [-38, -12], [72, -12], [56, 256]]) // prettier-ignore
  })

  it('unwraps the 9-bit X sign and puts OAM Y >= $E0 above the screen; the loader camera keeps its high bytes', () => {
    // Loader Layer 1 = (0x140, 0x1b0) through $1B and $1D; the sprite sits in its horizontal view.
    const r = draw(at(336, 112), runOf(() => [[0, 0x1f0, 0xe8], [1, 20, 30]]), { cam: [0x40, 1, 0xb0, 1] }) // prettier-ignore
    expect(dxy(r)).toEqual([[20 + 320 - 336, 30 + 432 - 112], [-16 + 320 - 336, -24 + 432 - 112]]) // prettier-ignore
  })

  it('does not move a part the loader image already had at that OAM position (seed residue); a partial match is moved', () => {
    // OAM 3 is the residue exactly; 6 differs in Y only, 7 in X only.
    const parts = () => [
      [3, 16, 48],
      [6, 70, 61],
      [7, 91, 50],
      [0, 184, 176],
    ]
    expect(dxy(draw(at(128, 112), runOf(parts)))).toEqual([[91 - 128, 50 + 192 - 112], [70 - 128, 61 + 192 - 112], [16 - 128, 48 - 112], [56, 256]]) // prettier-ignore
  })

  it('probes after a drawn main run only, 13 px by 11 px towards its screen centre, only to the drawn pass', () => {
    const seen: SpriteSeed[] = []
    const rec =
      (chosen: number): Run =>
      (r, i, s) => (seen.push(s), runOf(flame, chosen)(r, i, s))
    const trail = () => seen.splice(0).map(s => [s.camera.x, s.camera.y, s.mainPasses])
    draw(at(128, 112), rec(2))
    expect(trail()).toEqual([
      [0, 0, 64],
      [13, 11, 3],
    ])
    draw(at(96, 48), rec(0)) // left of and above its screen centre: the probe moves the other way
    expect(trail()).toEqual([
      [0, 0, 64],
      [-13, -11, 1],
    ])
  })

  it('runs once, no probe, when nothing drew, the run refused, the loader gave no image or the sprite is outside the loader view', () => {
    let runs = 0
    const count =
      (m: Run | SpriteModel): Run =>
      (r, i, s) => (runs++, typeof m === 'function' ? m(r, i, s) : m)
    const one = (m: Run | SpriteModel, s = at(128, 112), seedFor = () => loader()) => {
      runs = 0
      interpDrawer(blank, 0x104, { isVertical: false, screenCount: 2 }, count(m), seedFor)(s)
      return runs
    }
    expect(one(runOf(flame))).toBe(2) // control: this one does probe
    expect(one(model({ emptyReason: 'drew no tile', passes: [] }))).toBe(1)
    expect(one(model({ refusal: 'step budget spent' }))).toBe(1)
    expect(one(runOf(flame), at(128, 112), () => withSeed({}))).toBe(1)
    expect(one(runOf(flame), at(1544, 112))).toBe(1)
  })

  it('leaves a sprite outside the loader view at its offsets; the view is the scroll axis: X on a horizontal map, Y on a vertical one', () => {
    const only = () => [[0, 184, 176]]
    const spot = (s: LevelSprite, vertical: boolean) => dxy(draw(s, runOf(only), { vertical }))
    expect(spot(at(1544, 112), false)).toEqual([[-1104, 64]]) // camera (256, 0); X 1544 is outside [0, 256)
    expect(spot(at(1544, 224), false)).toEqual([[-1104, 64]]) // Y 224 is inside the loader's Y range, which does not matter here
    expect(spot(at(1544, 224), true)).toEqual([[184 - 1544, 176 + 192 - 224]]) // vertical: Y 224 is inside [192, 416)
    expect(spot(at(1544, 96), true)).toEqual([[-1104, 80]]) // vertical: Y 96 is outside
  })

  it('is not poisoned by an instance that drew nothing: a later one that draws is still placed from the loader camera', () => {
    // $8C draws only when SpriteXPosLow bit 4 is clear (bank_02.asm:15517-15519).
    const run: Run = (r, i, s) => (s.sprite.x & 16 ? model({ emptyReason: 'drew no tile', passes: [] }) : runOf(flame)(r, i, s)) // prettier-ignore
    const d = interpDrawer(blank, 0x104, { isVertical: false, screenCount: 2 }, run, () => loader())
    expect(d(at(144, 112)).ok).toBe(false)
    expect(dxy(d(at(128, 112)))).toEqual([
      [4, 8],
      [56, 256],
    ])
  })

  it('leaves parts alone when the loader gave no image', () => {
    const r = interpDrawer(blank, 0x104, { isVertical: false, screenCount: 2 }, runOf(flame), () => withSeed({}))(at(128, 112)) // prettier-ignore
    expect(dxy(r)).toEqual([
      [4, 8],
      [56, 64],
    ])
  })
})

describe('drawSprites with runtime palette writes', () => {
  const s = { index: 0, x: 0, y: 0, spriteId: 1, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as LevelSprite // prettier-ignore
  const chars = { sp1: [Uint8Array.from([1, 2, ...new Array(62).fill(0)])] }
  const withPalette = (runtimePalette: { index: number; bgr555: number }[]): SpriteDrawer => () => ({ ok: true, runtimePalette, parts: [{ charNum: 0x400, palette: 9, flipX: false, flipY: false, dx: 0, dy: 0 }], identity: { spriteId: 1, mainHandler: 0, initHandler: 0, status: 'vanilla' } }) // prettier-ignore
  const px2 = (d: MapSpriteDto) => [0, 1].map(x => Array.from(Buffer.from(d.rgba, 'base64').subarray(x * 4, x * 4 + 4))) // prettier-ignore

  it("the sprite's own CGRAM write changes the rendered color of that row and column only", () => {
    const [plain] = drawSprites([s], { vram: chars, colors: COLORS }, withPalette([]))
    // Row 9, column 2 (index 146) = BGR555 $7C00: pure blue, 248 in the blue byte.
    const [set] = drawSprites([s], { vram: chars, colors: COLORS }, withPalette([{ index: 9 * 16 + 2, bgr555: 0x7c00 }])) // prettier-ignore
    expect(px2(plain!)[0]).toEqual(px2(set!)[0])
    expect(px2(plain!)[1]).not.toEqual(px2(set!)[1])
    expect(px2(set!)[1]).toEqual([0, 0, 255, 255])
  })

  it('a write to another row is ignored', () => {
    const [a] = drawSprites([s], { vram: chars, colors: COLORS }, withPalette([]))
    const [b] = drawSprites([s], { vram: chars, colors: COLORS }, withPalette([{ index: 10 * 16 + 2, bgr555: 0x7c00 }])) // prettier-ignore
    expect(px2(a!)).toEqual(px2(b!))
  })
})

describe('a refused level loader marks every sprite unverified', () => {
  // A cart of zeros has no level loader: loadLevelState refuses it.
  const blank = RomFile.fromBytes('blank.sfc', Buffer.alloc(0x80000))
  const shape = { isVertical: false, screenCount: 2 }
  // Like the runner: the model says where its seed came from.
  const ran = (anchor: boolean, seed: SpriteSeed): SpriteModel => ({
    ...(seed.loaded
      ? { seedSource: 'rom-level-load' as const }
      : { seedSource: 'generic' as const, seedReason: seed.loadRefusal ?? 'none' }),
    ...ranModel(anchor),
  })
  const ranModel = (anchor: boolean): SpriteModel =>
    model(anchor ? { anchor: { x: 16, y: 16, rawX: 16, rawY: 16 }, passes: [{ pass: 0, pos: { x: 0, y: 0 }, parts: [part({ char: 0 })], uploads: [], palette: [] }], chosen: 0 } : { refusal: 'loop' }) // prettier-ignore
  const sprite = (i: number) => ({ index: i, x: 1, y: 1, spriteId: 1, screen: 0, extraBit: false, raw: [], streamOffset: 0 }) as LevelSprite // prettier-ignore
  const chars = { sp1: [new Uint8Array(64).fill(3)] }

  it('keeps drawing, with the loader reason on each sprite, drawn or marked', () => {
    let n = 0
    const draw = interpDrawer(blank, 0x105, shape, (_r, _i, seed) => ran(n++ === 0, seed))
    const [a, b] = drawSprites([sprite(0), sprite(1)], { vram: chars, colors: COLORS }, draw)
    expect(a).toMatchObject({ status: 'drawn' })
    expect(a!.unverified).toMatch(/^level loader refused \(.+\); drawn from a placement-only seed$/)
    expect(b).toMatchObject({ status: 'placeholder', reason: 'refused: loop' })
    expect(b!.unverified).toBe(a!.unverified)
  })

  it('seeds the run from the map shape alone, and says so once on the map', () => {
    const seeds: SpriteSeed[] = []
    const draw = interpDrawer(blank, 0x105, { isVertical: true, screenCount: 3 }, (_r, _i, seed) => (seeds.push(seed), ran(true, seed))) // prettier-ignore
    const r = spriteLayer(Uint8Array.from([0, 0x10, 0x01, 0x10, 0xff]), { vram: chars, colors: COLORS, isVertical: true, screenCount: 3 }, draw) // prettier-ignore
    expect(seeds[0]!.loaded).toBeUndefined()
    expect(seeds[0]).toMatchObject({ level: { screenMode: 1, screens: 3 } })
    expect(r.note).toMatch(/^Unverified: 1 sprites level loader refused/)
  })
})

describe('drawSprites with the interpreter', () => {
  it('draws at the anchor the drawer reports, not the stream position, and keeps the reason of a refusal', () => {
    const s = { index: 0, x: 2, y: 2, spriteId: 0x4f, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as LevelSprite // prettier-ignore
    const chars = { sp1: [new Uint8Array(64).fill(3)] }
    const ok: SpriteDrawer = () => ({ ok: true, anchor: { x: 40, y: 31 }, parts: [{ charNum: 0x400, palette: 9, flipX: false, flipY: false, dx: 0, dy: 0 }], identity: { spriteId: 0x4f, mainHandler: 0, initHandler: 0, status: 'vanilla' } }) // prettier-ignore
    const [a] = drawSprites([s], { vram: chars, colors: COLORS }, ok)
    expect(a).toMatchObject({
      x: 40,
      y: 31,
      status: 'drawn',
      box: { x0: 40, y0: 31, x1: 48, y1: 39 },
    })
    const [b] = drawSprites([s], { vram: chars, colors: COLORS }, () => ({
      ok: false,
      reason: 'refused: loop',
    }))
    expect(b).toMatchObject({ status: 'placeholder', reason: 'refused: loop', x: 32, y: 32 })
  })
})

/** Row `map:id@x,y` -> verdict, served anchor, digest of the interpreter's part keys (see `pinned`). One machine, vanilla. */
// prettier-ignore
const PINNED_ROWS: Record<string, string> = {
  '106:5@432,320': 'same 432,320 75b102da23',
  '106:5@448,320': 'same 448,320 75b102da23',
  '106:5@464,320': 'same 464,320 75b102da23',
  '106:5@480,320': 'same 480,320 75b102da23',
  '106:5@496,320': 'same 496,320 75b102da23',
  '106:5@512,320': 'same 512,320 75b102da23',
  '106:5@528,320': 'same 528,320 75b102da23',
  '106:5@544,320': 'same 544,320 75b102da23',
  '106:1@1344,368': 'same 1344,368 55d7cd9a11',
  '106:0@1696,368': 'same 1696,368 23dda30666',
  '106:4e@3088,304': 'same 3088,304 a890101608',
  '106:4e@3168,352': 'same 3168,352 a890101608',
  '106:4e@3424,320': 'same 3424,320 a890101608',
  '106:4d@3760,368': 'interp-miss - -',
  '106:4d@3952,368': 'same 3952,368 e53dc0877b',
  '8:2@128,304': 'differ 128,304 5c1daaa53f',
  '8:5@224,368': 'differ 224,368 73a3e6fff4',
  '8:5@288,368': 'differ 288,368 73a3e6fff4',
  '8:5@352,368': 'differ 352,368 73a3e6fff4',
  '8:5@416,368': 'differ 416,368 73a3e6fff4',
  '8:5@480,368': 'differ 480,368 73a3e6fff4',
  '8:5@544,368': 'differ 544,368 73a3e6fff4',
  '8:5@608,368': 'differ 608,368 73a3e6fff4',
  '8:5@672,368': 'differ 672,368 73a3e6fff4',
  '11b:3@144,368': 'differ 144,368 c2c726401e',
  '11b:4@208,368': 'differ 208,368 023e282179',
  '11b:5@272,368': 'differ 272,368 73a3e6fff4',
  '11b:6@336,368': 'differ 336,368 b4e706d4df',
  '11b:4@400,368': 'differ 400,368 023e282179',
  '11b:5@464,368': 'differ 464,368 73a3e6fff4',
  '11b:6@528,368': 'differ 528,368 b4e706d4df',
  '11b:4@592,368': 'differ 592,368 023e282179',
  '11b:5@656,368': 'differ 656,368 73a3e6fff4',
  '6:3@320,368': 'same 320,368 8db4314a8a',
  '6:f@528,368': 'same 528,368 b3ff82ca7b',
  '6:5@624,368': 'same 624,368 75b102da23',
  '6:6@768,368': 'same 768,368 7ea5a3a536',
  '6:6@880,368': 'same 880,368 7ea5a3a536',
  '6:5@1488,272': 'differ 1488,272 07f6cc95bd',
  '6:f@1552,368': 'same 1552,368 b3ff82ca7b',
  '6:f@1584,368': 'same 1584,368 b3ff82ca7b',
  '6:6@1600,288': 'same 1600,288 7ea5a3a536',
  '6:f@1616,368': 'same 1616,368 b3ff82ca7b',
  '6:f@1648,368': 'same 1648,368 b3ff82ca7b',
  '6:f@1680,368': 'same 1680,368 b3ff82ca7b',
  '1c2:11@224,304': 'differ 224,304 ece1e9ea01',
  '1c2:11@272,304': 'differ 272,304 ece1e9ea01',
  '1c2:11@416,352': 'differ 416,352 ece1e9ea01',
  '1c2:11@560,288': 'differ 560,288 ece1e9ea01',
  '1c2:11@976,352': 'differ 976,352 ece1e9ea01',
  '1:13@2720,240': 'differ 2720,240 29a7dadd44',
  '1:13@3312,320': 'differ 3312,320 29a7dadd44',
  '1:13@3376,352': 'differ 3376,352 29a7dadd44',
  '1:13@3728,368': 'differ 3728,368 29a7dadd44',
  '1:13@3744,368': 'differ 3744,368 29a7dadd44',
  '1:13@3760,368': 'differ 3760,368 29a7dadd44',
  '1:13@3776,368': 'differ 3776,368 29a7dadd44',
  '1:13@3792,368': 'differ 3792,368 29a7dadd44',
  '1:13@3808,368': 'differ 3808,368 29a7dadd44',
  '1:13@3824,368': 'differ 3824,368 29a7dadd44',
  '1:13@3840,368': 'differ 3840,368 29a7dadd44',
  '11c:1f@352,336': 'differ 352,336 9c12455c79',
}

/**
 * The known engine-vs-interpreter list over MAPS below (vanilla, one machine,
 * 62 sprites the engine draws): 25 agree exactly, 36 differ, 1 the interpreter
 * draws no tile for in 64 passes ($4D).
 */
const EXPECTED: Record<string, Record<string, number>> = {
  $00: { same: 1 },
  $01: { same: 1 },
  $02: { differ: 1 },
  $03: { differ: 1, same: 1 },
  $04: { differ: 3 },
  $05: { same: 9, differ: 12 },
  $06: { differ: 2, same: 3 },
  $0F: { same: 6 },
  $11: { differ: 5 },
  $13: { differ: 11 },
  $1F: { differ: 1 },
  $4D: { 'interp-miss': 1, same: 1 },
  $4E: { same: 3 },
}

const GPW = 'GrandPooWorld_V1.2.sfc'
describe.skipIf(!hasRom(GPW))(
  'GPW 1.2: the level loader refuses, the drawer still draws, flagged',
  () => {
    // Through the drawer, not mapSprites: every cart whose loader refuses also has a
    // LoadLevel shape the map model refuses (all 512 maps unavailable), so the map
    // never reaches this path on these carts today.
    it('answers every sprite of a level with the loader reason', () => {
      const rom = new SmwRom(RomFile.load(romPath(GPW)))
      expect(loadLevelState(rom.rom, 0x105).ok).toBe(false)
      let sprites: LevelSprite[] = []
      let level = 0
      for (; level < 0x200 && sprites.length === 0; level++) {
        const ptr = rom.getLevelSpritePointer(level)
        sprites = ptr === null ? [] : parseLevelSprites(rom.rom.readUpTo(ptr, 0x200)!, false).filter(s => !((s.raw[0] ?? 0) & 8)) // prettier-ignore
      }
      expect(sprites.length).toBeGreaterThan(0)
      const draw = interpDrawer(rom.rom, level - 1, { isVertical: false, screenCount: 0x14 })
      const answers = sprites.map(draw)
      expect(answers.every(a => /^level loader refused/.test(('unverified' in a && a.unverified) || ''))).toBe(true) // prettier-ignore
      // GPW's HandleSprite is not the stock dispatch either, so the runner refuses here too:
      // the marker carries both reasons. The drawn case is the synthetic test above.
      expect(answers.every(a => !a.ok && /^refused: /.test(a.reason))).toBe(true)
    })
  },
)

describe.skipIf(!hasRom(VANILLA))('interpreter vs table engine on vanilla maps', () => {
  /** Maps holding every id the engine draws, plus the two the issue names. */
  const MAPS = [0x105, 0x106, 0x00f, 0x1c5, 0x008, 0x11b, 0x006, 0x1c2, 0x001, 0x11c]
  const bytes = () => new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)

  interface Row { map: number; id: number; at: string; verdict: 'same' | 'differ' | 'interp-miss'; e?: string; i?: string; anchor?: string } // prettier-ignore

  /** Per sprite the engine draws: both sides' parts relative to their own anchor, order-free. */
  function compare(wrap: (d: SpriteDrawer) => SpriteDrawer = d => d): Row[] {
    const b = bytes()
    const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const rows: Row[] = []
    for (const map of MAPS) {
      const built = new L1ModelCache().get(b, romPath(VANILLA), map, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const sprites = parseLevelSprites(rom.rom.readUpTo(rom.getLevelSpritePointer(map)!, 0x200)!, built.inputs.isVertical) // prettier-ignore
      const eng = engineDrawer(rom.rom, readMarioStartPos(rom.rom, map).x)!
      const interp = interpDrawer(rom.rom, map, built.inputs)
      const both = wrap(interp)
      for (const s of sprites) {
        const e = eng(s)
        if (!e.ok || (s.raw[0]! & 8) !== 0) continue
        const g = both(s)
        const at = `${s.x * 16},${s.y * 16}`
        if (!g.ok) { rows.push({ map, id: s.spriteId, at, verdict: 'interp-miss' }); continue } // prettier-ignore
        const [ek, ik] = [
          e.parts.map(partKey).sort().join(';'),
          g.parts.map(partKey).sort().join(';'),
        ]
        const anchor = g.anchor ? `${g.anchor.x},${g.anchor.y}` : at
        rows.push({
          map,
          id: s.spriteId,
          at,
          verdict: ek === ik ? 'same' : 'differ',
          e: ek,
          i: ik,
          anchor,
        })
      }
    }
    return rows
  }

  const pinned = (rows: Row[]) =>
    Object.fromEntries(
      rows.map(r => [
        `${r.map.toString(16)}:${r.id.toString(16)}@${r.at}`,
        `${r.verdict} ${r.anchor ?? '-'} ${r.i === undefined ? '-' : createHash('sha1').update(r.i).digest('hex').slice(0, 10)}`,
      ]),
    )

  const tally = (rows: Row[]) => {
    const out: Record<string, Record<string, number>> = {}
    for (const r of rows) {
      const k = `$${r.id.toString(16).toUpperCase().padStart(2, '0')}`
      out[k] ??= {}
      out[k]![r.verdict] = (out[k]![r.verdict] ?? 0) + 1
    }
    return out
  }

  it('lists where they disagree in parts relative to the anchor, and goes red when that list changes', () => {
    const rows = compare()
    const t = tally(rows)
    console.log(
      `engine vs interpreter over ${MAPS.length} maps, ${rows.length} sprites: ${JSON.stringify(t)}`,
    )
    for (const r of rows.filter(r => r.verdict !== 'same'))
      console.log(`${r.verdict} map ${r.map.toString(16)} id ${r.id.toString(16)} at ${r.at}\n  engine ${r.e}\n  interp ${r.i}`) // prettier-ignore
    // The known list. Of the 36 differing rows: 19 are tile/flip (the engine's frame-0 pose
    // against a later walk-cycle frame or a facing), 16 are +1 px Y walk-frame offsets (ids $03-$06, overlapping the tile bucket),
    // and $1F on $11C relocates itself in its own MAIN (x 352 to 304 by pass 1, flipped,
    // depending on Mario and the RNG); one id draws nothing. A new entry, or one that clears, fails here.
    expect(t).toEqual(EXPECTED)
    // Per row: verdict, served anchor and a digest of the interpreter's part keys, so a
    // change INSIDE a differing row (a tile, a flip, a pixel) is as red as a new row.
    expect(pinned(rows)).toEqual(PINNED_ROWS)
  })

  it('goes red on a planted defect: one part shifted by a pixel is a disagreement', () => {
    const base = tally(compare())
    const planted = tally(
      compare(d => s => {
        const r = d(s)
        return r.ok ? { ...r, parts: r.parts.map(p => ({ ...p, dx: p.dx + 1 })) } : r
      }),
    )
    expect(planted).not.toEqual(base)
    expect(planted).not.toEqual(EXPECTED)
  })

  it('goes red when a part changes INSIDE a row that already differs (the verdict counts stay equal)', () => {
    const rows = compare(d => s => {
      const r = d(s)
      // $13 differs from the engine already; one more pixel keeps it "differ".
      return r.ok && s.spriteId === 0x13
        ? { ...r, parts: r.parts.map(p => ({ ...p, dy: p.dy + 1 })) }
        : r
    })
    expect(tally(rows)).toEqual(EXPECTED)
    expect(pinned(rows)).not.toEqual(PINNED_ROWS)
  })

  it('caches an ok reply per bytes and map, at most 8 of them (least recently used out), and never an unavailable one', () => {
    const b = bytes()
    const c = new L1ModelCache()
    const get = (m: number) => mapSprites(c, b, romPath(VANILLA), m)
    const first = get(0x105)
    expect(get(0x105)).toBe(first)
    // $095 is a boss arena the map model refuses: asked twice, answered twice.
    expect(get(0x095).status).toBe('unavailable')
    expect(get(0x095)).not.toBe(get(0x095))
    const second = get(0x106)
    for (const m of [0x00f, 0x1c5, 0x008, 0x11b, 0x006, 0x1c2]) get(m) // eight replies now
    expect(get(0x105)).toBe(first) // a hit refreshes it: LRU, not first-in
    get(0x001) // the ninth: the least recently used ($106) goes, not $105
    expect(get(0x105)).toBe(first)
    expect(get(0x106)).not.toBe(second)
  })

  it('$8C (Side Exit) on $104 draws its flame at map (184, 368), inside the fireplace, not at the list position (#286)', () => {
    const r = mapSprites(new L1ModelCache(), bytes(), romPath(VANILLA), 0x104)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    const flame = r.sprites.filter(d => d.id === 0x8c)
    // One Mesen capture of vanilla $104: OAM (184,176) with Layer 1 Y 192. x0/y0 is the box's top-left.
    expect(flame.map(d => [d.status, d.box.x0, d.box.y0])).toEqual([['drawn', 184, 368]])
  })

  it('$4F on $105 is served at its stream position plus (8, -1): INIT moved it, not a table', () => {
    const b = bytes()
    const r = mapSprites(new L1ModelCache(), b, romPath(VANILLA), 0x105)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const raw = parseLevelSprites(rom.rom.readUpTo(rom.getLevelSpritePointer(0x105)!, 0x200)!, false).filter(s => s.spriteId === 0x4f) // prettier-ignore
    const served = r.sprites.filter(s => s.id === 0x4f)
    expect(served.map(s => [s.x, s.y])).toEqual([[1816, 335], [2232, 319], [4552, 319]]) // prettier-ignore
    expect(served.map(s => [s.x, s.y])).toEqual(raw.map(s => [s.x * 16 + 8, s.y * 16 - 1]))
    expect(served.every(s => s.status === 'drawn')).toBe(true)
  })

  it('runtime colors: the last upload of $1F (Magikoopa) is the colors the table engine splices in', () => {
    const b = bytes()
    const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const map = 0x11c
    const level = loadLevelState(rom.rom, map)
    if (!level.ok) throw new Error(level.reason)
    const sprite = parseLevelSprites(rom.rom.readUpTo(rom.getLevelSpritePointer(map)!, 0x200)!, false).find(x => x.spriteId === 0x1f)! // prettier-ignore
    const [x, y] = [sprite.x * 16, sprite.y * 16]
    const m = runOnce(rom.rom, 0x1f, withSeed({ sprite: { x, y }, camera: cameraFor(x, y, false, 20), mario: readMarioStartPos(rom.rom, map), loaded: level.wram })) // prettier-ignore
    const written = m.passes.at(-1)!.palette
    const note = engineDrawer(rom.rom, 0)!(sprite)
    if (!note.ok || !('paletteNote' in note) || !note.paletteNote) throw new Error('engine has no dynamicCgram note') // prettier-ignore
    const n = note.paletteNote
    const bytesAt = rom.rom.readAt(n.entryAddr, n.colors * 2)!
    const want = Array.from({ length: n.colors }, (_, i) => ({ index: n.row * 16 + n.firstCol + i, bgr555: (bytesAt[i * 2]! | (bytesAt[i * 2 + 1]! << 8)) & 0x7fff })) // prettier-ignore
    expect(written.slice(-n.colors)).toEqual(want)
    // The served frame is the first that draws, which precedes the first upload: no colors yet.
    expect(m.chosen).toBeDefined()
    expect(m.passes[m.chosen!]!.palette).toEqual([])
  })

  it('$C5 (the boss Big Boo on $0E4) is served with the colors its own code uploads, in its pixels', () => {
    const b = bytes()
    const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const built = new L1ModelCache().get(b, romPath(VANILLA), 0xe4, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
    if (!built.ok) throw new Error(built.reason)
    const draw = interpDrawer(rom.rom, 0xe4, built.inputs)
    const s = parseLevelSprites(rom.rom.readUpTo(rom.getLevelSpritePointer(0xe4)!, 0x200)!, false).find(x => x.spriteId === 0xc5)! // prettier-ignore
    const r = draw(s)
    expect(r.ok && 'runtimePalette' in r && r.runtimePalette?.length).toBe(8)
    // Served pixels: with the sprite's own writes dropped, the bitmap must differ.
    const withColors = drawSprites([s], built.inputs, draw)[0]!
    const without = drawSprites([s], built.inputs, x => {
      const d = draw(x)
      return d.ok ? { ...d, runtimePalette: [] } : d
    })[0]!
    expect(withColors.status).toBe('drawn')
    expect(withColors.rgba).not.toBe(without.rgba)
  })

  it("the served seed on $1C5 carries the loader's Mario (136, 368), not the table's (128, 368)", () => {
    const b = bytes()
    const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const built = new L1ModelCache().get(b, romPath(VANILLA), 0x1c5, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
    if (!built.ok) throw new Error(built.reason)
    expect(readMarioStartPos(rom.rom, 0x1c5)).toEqual({ x: 128, y: 368 }) // what the table says
    const seeds: SpriteSeed[] = []
    const draw = interpDrawer(rom.rom, 0x1c5, built.inputs, (r, id, seed) => (seeds.push(seed), runOnce(r, id, seed))) // prettier-ignore
    const s = parseLevelSprites(
      rom.rom.readUpTo(rom.getLevelSpritePointer(0x1c5)!, 0x200)!,
      false,
    )[0]!
    draw(s)
    expect(seeds[0]!.mario).toMatchObject({ x: 136, y: 368 })
  })

  it('counts drawn and marked sprites on $105 and $106, every marker with the interpreter reason', () => {
    const b = bytes()
    const got = [0x105, 0x106].map(m => {
      const r = mapSprites(new L1ModelCache(), b, romPath(VANILLA), m)
      if (r.status !== 'ok') throw new Error(JSON.stringify(r))
      for (const s of r.sprites.filter(s => s.status === 'placeholder')) expect(s.reason).toMatch(/^(refused: INIT: id \$[0-9a-f]+ is past|drew no OAM tile)/) // prettier-ignore
      expect(r.sprites.some(s => s.unverified)).toBe(false)
      return [r.sprites.filter(s => s.status === 'drawn').length, r.sprites.length]
    })
    expect(got).toEqual([
      [31, 34],
      [21, 25],
    ])
  })
})
