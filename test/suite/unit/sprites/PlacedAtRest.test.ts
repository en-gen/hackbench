/**
 * The at-rest mode (#980): a sprite's INIT runs for its PICTURE only (D139 D, D138 A) and the drawing is
 * re-based onto the placed (list) spot, so INIT's moves are not shown (D134, D91). The synthetic block needs
 * no ROM; the corpus block runs the real chainsaws and grinders.
 */
import { describe, it, expect } from 'vitest'
import { runOnce, RAM } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { parseLevelSprites, type LevelSprite } from '../../../../src/rom/LevelParser'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { frameRun, interpRunner } from '../../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../../support/corpus'
import { GRINDER_DISPATCH } from '../../support/syntheticGrinder'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()

describe('at-rest mode on a synthetic cart', () => {
  // Id 0: INIT adds 8 to X; MAIN draws one piece at the sprite position.
  it("draws at the placed spot after INIT ran for the picture (D139 D); INIT's +8 is not shown", () => {
    const m = runOnce(rom, 0, SPRITE_SEED, { init: false })
    expect(m.refusal).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x80, y: 0x80, rawX: 0x80, rawY: 0x80 })
    expect(m.initFrames).toBe(1)
    expect(m.chosen).toBe(0)
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
  it('keeps what INIT wrote for the look (id 20: INIT sets a CGRAM color)', () => {
    const rest = runOnce(rom, 20, SPRITE_SEED, { init: false }).passes[0]!.palette
    expect(rest.length).toBeGreaterThan(0)
    expect(rest).toEqual(runOnce(rom, 20, SPRITE_SEED).passes[0]!.palette)
  })
  it('the default still runs INIT (graders, timelines)', () => {
    const m = runOnce(rom, 0, SPRITE_SEED)
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 0x88, rawX: 0x80 })
    expect(runOnce(rom, 0, SPRITE_SEED, { init: true }).anchor?.x).toBe(0x88)
  })
  it('follows the seed: a different placed spot moves the picture with it', () => {
    const m = runOnce(rom, 0, withSeed({ sprite: { x: 0x140, y: 0x90 } }), { init: false })
    expect(m.anchor).toMatchObject({ x: 0x140, y: 0x90 })
  })
})

describe.skipIf(!hasRom(VANILLA))('at rest on vanilla', () => {
  const bytes = () => new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)
  const placed = (map: number, id: number) => {
    const b = bytes()
    const smw = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const built = new L1ModelCache().get(b, romPath(VANILLA), map, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
    if (!built.ok) throw new Error(built.reason)
    const list = parseLevelSprites(smw.rom.readUpTo(smw.getLevelSpritePointer(map)!, 0x200)!, built.inputs.isVertical).filter(s => s.spriteId === id) // prettier-ignore
    const run = interpRunner(smw.rom, map, built.inputs)
    return list.map(s => ({ s, r: run(s) }))
  }
  // The last number is how many draw a tile; the rest show the marker (D52): INIT runs for the picture
  // (D139 D), and 7 of the chainsaws and 3 of the grinders put no tile on the spawn-centred screen.
  for (const [map, id, drawn] of [
    [0x0f, 0x65, 23],
    [0x1a, 0x67, 10],
  ] as const)
    it(`every $${id.toString(16)} on map $${map.toString(16)} draws at its list position`, () => {
      const got = placed(map, id)
      expect(got.length).toBeGreaterThan(0)
      let n = 0
      for (const { s, r } of got) {
        if (!('m' in r)) throw new Error('direct answer')
        expect(r.m.refusal).toBeUndefined()
        expect([r.m.anchor?.x, r.m.anchor?.y]).toEqual([s.x * 16, s.y * 16])
        expect(r.m.anchor).toMatchObject({ rawX: s.x * 16, rawY: s.y * 16 })
        if (r.m.chosen !== undefined) n++
        else expect(r.m.emptyReason).toMatch(/drew no OAM tile/)
      }
      expect(n).toBe(drawn)
    })
})

describe('what at rest starts from', () => {
  const status = (id: number, init?: boolean) => {
    let st = -1
    runOnce(rom, id, SPRITE_SEED, { init, probe: (p, w) => { if (p === -1) st = w[RAM.status + SPRITE_SEED.slot]! } }) // prettier-ignore
    return st
  }
  it('stops where the game hands control to INIT (status 8), and a shell keeps the loader status 9', () => {
    expect(status(0, false)).toBe(8)
    expect(status(0xda, false)).toBe(9)
    expect(runOnce(rom, 0xda, SPRITE_SEED, { init: false }).refusal).toBeUndefined()
  })
  it('a $67-style sprite whose first drawing pass is above 0 keeps the raw anchor at rest', () => {
    const opts = { grinderDispatch: GRINDER_DISPATCH }
    const r = buildSyntheticRom({ grinderDrawsFromPass1: true })
    const played = runOnce(r, 103, SPRITE_SEED, opts)
    const rest = runOnce(r, 103, SPRITE_SEED, { ...opts, init: false })
    expect(rest.chosen).toBe(1)
    expect(rest.anchor).toMatchObject({ x: 0x80, y: 0x80 })
    expect(played.anchor!.x).not.toBe(0x80)
  })
  it('a sprite that draws nothing at rest says its look is set up when the map runs', () => {
    const m = runOnce(buildSyntheticRom({ noTileWrite: true }), 0, SPRITE_SEED, { init: false })
    expect(m.emptyReason).toMatch(/set up when the map runs and shown on play/)
  })
})

describe('the served paths run at rest', () => {
  const shape = { isVertical: false, screenCount: 1 }
  const base = withSeed({ loaded: new Uint8Array(0x20000) }, SPRITE_SEED)
  const s = { index: 0, x: 8, y: 8, spriteId: 0, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as LevelSprite // prettier-ignore
  const ran = (
    r: ReturnType<typeof interpRunner> extends (s: LevelSprite) => infer R ? R : never,
  ) => {
    if (!('m' in r)) throw new Error('direct answer')
    return r.m
  }
  // D139 D, D138 A: INIT runs for the picture; the drawing stays on the placed spot (D134, D91).
  const s20 = { ...s, spriteId: 20 } as LevelSprite
  it("interpRunner draws INIT's picture at the placed spot", () => {
    const m = ran(interpRunner(rom, 0, shape, undefined, () => base)(s))
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 128, y: 128, rawX: 128, rawY: 128 })
    expect(ran(interpRunner(rom, 0, shape, undefined, () => base)(s20)).passes[0]!.palette.length).toBeGreaterThan(0) // prettier-ignore
  })
  it("the frames of a sprite are run with INIT's picture at the placed spot", () => {
    const m = ran(frameRun(rom, 0, shape, base, s))
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 128, y: 128 })
    expect(ran(frameRun(rom, 0, shape, base, s20)).passes[0]!.palette.length).toBeGreaterThan(0)
  })
})

describe('the D139 picture', () => {
  it('re-bases a sprite INIT moved (id 0: +8) onto the placed spot, its look kept', () => {
    const m = runOnce(rom, 0, SPRITE_SEED, { init: false })
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 0x80, rawX: 0x80 })
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
})
