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
import { shiftNote } from '../../../../theia/extension/src/browser/sprite-props'
import {
  frameRun,
  interpRunner,
  modelResult,
} from '../../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../../support/corpus'
import { grinderShape } from '../../support/syntheticGrinder'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()

describe('at-rest mode on a synthetic cart', () => {
  // Id 0: INIT adds 8 to X; MAIN draws one piece at the sprite position.
  it("draws at the placed spot after INIT ran for the picture (D139 D); INIT's +8 is not shown", () => {
    const m = runOnce(rom, 0, SPRITE_SEED, { atRest: true })
    expect(m.refusal).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x80, y: 0x80, rawX: 0x80, rawY: 0x80 })
    expect(m.initFrames).toBe(1)
    expect(m.chosen).toBe(0)
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
  it('keeps what INIT wrote for the look (id 20: INIT sets a CGRAM color)', () => {
    const rest = runOnce(rom, 20, SPRITE_SEED, { atRest: true }).passes[0]!.palette
    expect(rest.length).toBeGreaterThan(0)
    expect(rest).toEqual(runOnce(rom, 20, SPRITE_SEED).passes[0]!.palette)
  })
  it('the default still runs INIT (graders, timelines)', () => {
    const m = runOnce(rom, 0, SPRITE_SEED)
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 0x88, rawX: 0x80 })
    expect(runOnce(rom, 0, SPRITE_SEED, { atRest: false }).anchor?.x).toBe(0x88)
  })
  it('follows the seed: a different placed spot moves the picture with it', () => {
    const m = runOnce(rom, 0, withSeed({ sprite: { x: 0x140, y: 0x90 } }), { atRest: true })
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
  // The last number is how many draw a tile: all of them. INIT moves these sprites off the screen the run
  // is centred on (a culled draw), so the picture is taken again with the camera moved (D139 D).
  for (const [map, id, drawn] of [
    [0x0f, 0x65, 30],
    [0x1a, 0x67, 13],
  ] as const)
    it(`every $${id.toString(16)} on map $${map.toString(16)} draws where its INIT leaves it: 320 px left (even column) or 15 px right (odd), R16`, () => {
      const got = placed(map, id)
      expect(got.length).toBeGreaterThan(0)
      let n = 0
      for (const { s, r } of got) {
        if (!('m' in r)) throw new Error('direct answer')
        expect(r.m.refusal).toBeUndefined()
        // The oracle is InitLineGuidedSpr (bank_01.asm:11788-11809): bit 4 of X clear subtracts $140, set adds $0F.
        // The run supplies the number; this only checks that it agrees.
        const dx = (s.x * 16) & 0x10 ? 15 : -320
        expect([r.m.anchor?.x, r.m.anchor?.y]).toEqual([s.x * 16 + dx, s.y * 16])
        expect(r.m.anchor).toMatchObject({ rawX: s.x * 16, rawY: s.y * 16 })
        expect(r.m.shifted).toBe(true)
        if (r.m.chosen !== undefined) n++
        else expect(r.m.emptyReason).toMatch(/drew no OAM tile/)
      }
      expect(n).toBe(drawn)
    })
})

describe('a line-guided sprite whose INIT shifts it is drawn where INIT left it (R16, synthetic cart)', () => {
  const shifting = buildSyntheticRom({ grinderInitShifts: true })
  const opts = { atRest: true, grinderDispatch: grinderShape(shifting) }
  it("id 103 ($67): the picture stands on INIT's spot, the list spot is kept as raw, and the model says so", () => {
    const m = runOnce(shifting, 103, SPRITE_SEED, opts)
    expect(m.anchor).toMatchObject({ x: 0x88, y: 0x80, rawX: 0x80, rawY: 0x80 })
    expect(m.shifted).toBe(true)
    expect(m.chosen).toBe(0)
  })
  it('the same INIT on an id the rule is not for (31) leaves the picture on the list spot', () => {
    const m = runOnce(shifting, 31, SPRITE_SEED, opts)
    expect(m.anchor).toMatchObject({ x: 0x80, y: 0x80 })
    expect(m.shifted).toBeUndefined()
  })
  it('a handler the gate refuses (not the stock calls) keeps the list spot: no shift without a verified first frame', () => {
    const altered = buildSyntheticRom({ grinderInitShifts: true, alteredGrinder: true })
    const m = runOnce(altered, 103, SPRITE_SEED, { atRest: true, grinderDispatch: grinderShape(altered) }) // prettier-ignore
    expect(m.anchor).toMatchObject({ x: 0x80, y: 0x80 })
    expect(m.shifted).toBeUndefined()
  })
  it('the DTO carries the stored tile, and the properties note says how far, from the same run', () => {
    const res = modelResult(runOnce(shifting, 103, SPRITE_SEED, opts))
    expect(res).toMatchObject({
      ok: true,
      anchor: { x: 0x88, y: 0x80 },
      stored: { x: 0x80, y: 0x80 },
    })
    expect(shiftNote({ x: 0x88, y: 0x80, stored: { x: 0x80, y: 0x80 } })).toMatch(
      /8 px to the right/,
    )
  })
})

describe('first frame at rest on synthetic carts: the run decides (R16, findings 2-4)', () => {
  const at = (x: number, y: number) => withSeed({ slot: 3, sprite: { x, y } }, SPRITE_SEED)
  const rest = (o: Parameters<typeof buildSyntheticRom>[0], seed = SPRITE_SEED) => {
    const rom = buildSyntheticRom(o)
    return runOnce(rom, 103, seed, { atRest: true, grinderDispatch: grinderShape(rom) })
  }

  it('a gated line-guided sprite whose INIT does not move it is not shifted, and carries no stored tile', () => {
    const m = rest({})
    expect(m.shifted).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x80, y: 0x80 })
    expect(modelResult(m)).not.toHaveProperty('stored')
  })

  it('one whose INIT moves it is, by exactly what INIT did (+8, then -$140 reaching a negative X)', () => {
    expect(rest({ grinderInitShifts: true }).anchor).toMatchObject({ x: 0x88, y: 0x80 })
    // Signed X (mutant: the 16-bit value left unsigned would read 65280): near the left edge, -$140 gives -$100.
    const left = rest({ grinderInitDelta: [-0x140, 0] }, at(0x40, 0x80))
    expect(left.anchor).toMatchObject({ x: -0x100, y: 0x80, rawX: 0x40 })
    expect(left.shifted).toBe(true)
    expect(left.chosen).toBe(0)
  })

  it('an INIT that sets Y negative stands on the negative Y (signed Y)', () => {
    const up = rest({ grinderInitDelta: [0, -0x80] }, at(0x80, 0x40))
    expect(up.anchor).toMatchObject({ x: 0x80, y: -0x40, rawY: 0x40 })
    expect(up.shifted).toBe(true)
    expect(shiftNote({ x: 0x80, y: -0x40, stored: { x: 0x80, y: 0x40 } })).toMatch(/128 px up/)
  })

  it('start-up code and the first step both move it: the DTO carries where start-up left it, and the note splits 8 and 4 px', () => {
    const rom = buildSyntheticRom({ grinderInitShifts: true, grinderDrawsFromPass1: true })
    const m = runOnce(rom, 103, SPRITE_SEED, { atRest: true, grinderDispatch: grinderShape(rom) })
    expect(m.anchor).toMatchObject({ x: 0x8c, y: 0x80 }) // 128 + 8 (INIT) + 4 (pass 0's step)
    const res = modelResult(m)
    expect(res).toMatchObject({ ok: true, anchor: { x: 0x8c }, stored: { x: 0x80 }, afterInit: { x: 0x88, y: 0x80 } }) // prettier-ignore
    const dto = res as {
      anchor: { x: number; y: number }
      stored: { x: number; y: number }
      afterInit: { x: number; y: number }
    }
    expect(shiftNote({ ...dto.anchor, stored: dto.stored, afterInit: dto.afterInit })).toMatch(/start-up code moves it 8 px to the right, and its first step 4 px to the right more/) // prettier-ignore
  })

  it('when the first drawing pass is above 0 the anchor is the origin its parts are measured from (finding 3)', () => {
    const m = rest({ grinderInitShifts: true, grinderDrawsFromPass1: true })
    expect(m.chosen).toBe(1)
    expect(m.shifted).toBe(true)
    expect(m.anchor!.x).toBe(m.passes[1]!.origin.x)
    expect(m.anchor!.y).toBe(m.passes[1]!.origin.y)
    expect(m.passes[1]!.parts[0]!.dx).toBe(0)
  })
})

describe.skipIf(!hasRom(VANILLA))(
  'which sprites are drawn away from their list position (R16)',
  () => {
    const seed3 = withSeed({ slot: 3, sprite: { x: 0x80, y: 0x80 } }, SPRITE_SEED)
    it('what moves a picture off its list position is the run: no id decides it (R16)', () => {
      const r = RomFile.load(romPath(VANILLA))
      const drawn: number[] = []
      for (let id = 0; id <= 0xc8; id++) {
        const m = runOnce(r, id, seed3, { atRest: true })
        const off = m.anchor !== undefined && (m.anchor.x !== m.anchor.rawX || m.anchor.y !== m.anchor.rawY) // prettier-ignore
        expect(m.shifted === true, `id ${id}`).toBe(off)
        // Only a sprite the line-guided gate admitted can be drawn off its list position at rest.
        if (off) {
          expect(m.snaps, `id ${id}`).toBe(true)
          drawn.push(id)
        }
      }
      expect(drawn).toEqual([0x64, 0x65, 0x66, 0x67, 0x68])
    })

    it('by how much: 320 px left (even column) or 15 px right (odd) for $65-$68, 2 px right for the $64 rope, none for $62 and $63', () => {
      const r = RomFile.load(romPath(VANILLA))
      for (const x of [0x80, 0x90]) {
        const dx = (id: number) => {
          const m = runOnce(r, id, withSeed({ slot: 3, sprite: { x, y: 0x80 } }, SPRITE_SEED), { atRest: true }) // prettier-ignore
          return [m.anchor!.x - x, m.anchor!.y - 0x80]
        }
        for (const id of [0x65, 0x66, 0x67, 0x68]) expect(dx(id), `id ${id} at ${x}`).toEqual([x & 0x10 ? 15 : -320, 0]) // prettier-ignore
        expect(dx(0x64)).toEqual([2, 0])
        expect(dx(0x62)).toEqual([0, 0])
        expect(dx(0x63)).toEqual([0, 0])
      }
    })
  },
)

describe('a sprite INIT moves off the screen it was run on (camera re-run)', () => {
  // INIT adds 256 px to X and MAIN draws only on screen, as GetDrawInfo does: the first run culls it.
  const far = buildSyntheticRom({ initFarCull: true })
  it('still draws its tile, at the placed spot, not the marker (D139 D)', () => {
    const m = runOnce(far, 0, SPRITE_SEED, { atRest: true })
    expect(m.emptyReason).toBeUndefined()
    expect(m.chosen).toBe(0)
    expect(m.anchor).toMatchObject({ x: 0x80, y: 0x80, rawX: 0x80, rawY: 0x80 })
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
  it('draws the full picture when MAIN moves it partway back before drawing (a Podoboo)', () => {
    const m = runOnce(buildSyntheticRom({ initFarCull: true, mainStepsBack: true }), 0, SPRITE_SEED, { atRest: true }) // prettier-ignore
    expect(m.chosen).toBe(0)
    expect(m.anchor).toMatchObject({ x: 0x80, y: 0x80 })
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
  it('play keeps the cull: INIT-on has no re-run and draws nothing', () => {
    expect(runOnce(far, 0, SPRITE_SEED).emptyReason).toMatch(/drew no OAM tile/)
  })
})

describe('what at rest starts from', () => {
  const status = (id: number, atRest?: boolean) => {
    let st = -1
    runOnce(rom, id, SPRITE_SEED, { atRest, probe: (p, w) => { if (p === -1) st = w[RAM.status + SPRITE_SEED.slot]! } }) // prettier-ignore
    return st
  }
  it('stops where the game hands control to INIT (status 8), and a shell keeps the loader status 9', () => {
    expect(status(0, true)).toBe(8)
    expect(status(0xda, true)).toBe(9)
    expect(runOnce(rom, 0xda, SPRITE_SEED, { atRest: true }).refusal).toBeUndefined()
  })
  it('a $67-style sprite whose first drawing pass is above 0 stands where the game first drew it, not on the list spot (R16)', () => {
    const r = buildSyntheticRom({ grinderDrawsFromPass1: true })
    const opts = { grinderDispatch: grinderShape(r) }
    const played = runOnce(r, 103, SPRITE_SEED, opts)
    const rest = runOnce(r, 103, SPRITE_SEED, { ...opts, atRest: true })
    expect(rest.chosen).toBe(1)
    // INIT does not move it, but pass 0's step does (+4) before pass 1 draws: the anchor is the origin the parts are
    // measured from (132 = 0x84), and the sprite is marked as drawn away from its map tile. Before: 128 and 132.
    expect(rest.passes[1]!.origin.x).toBe(0x84)
    expect(rest.anchor).toMatchObject({ x: 0x84, y: 0x80, rawX: 0x80 })
    expect(rest.shifted).toBe(true)
    expect(rest.passes[1]!.parts[0]!.dx).toBe(0)
    expect(played.anchor!.x).not.toBe(0x80)
  })
  it('a sprite that draws nothing at rest says only that it drew no tile and was not checked in play', () => {
    const m = runOnce(buildSyntheticRom({ noTileWrite: true }), 0, SPRITE_SEED, { atRest: true })
    expect(m.emptyReason).toMatch(
      /drew no OAM tile in \d+ passes \(it drew no tile at rest; whether it shows in play was not checked\)/,
    )
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
    const m = runOnce(rom, 0, SPRITE_SEED, { atRest: true })
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 0x80, rawX: 0x80 })
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
})
