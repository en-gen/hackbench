/**
 * The at-rest mode (#980): a sprite's INIT runs, and since #1231 the drawing stands where INIT leaves the sprite, for
 * every sprite, with the list spot kept as `rawX`, `rawY` (this replaced the re-base onto the placed spot, D134, D91).
 * The synthetic block needs no ROM; the corpus block runs the real chainsaws and grinders.
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
import { slow } from '../../support/loadTimeout'

const rom = buildSyntheticRom()

describe('at-rest mode on a synthetic cart', () => {
  // Id 0: INIT adds 8 to X; MAIN draws one piece at the sprite position.
  it("draws where INIT left the sprite (#1231): INIT's +8 is shown, the list spot kept as raw", () => {
    const m = runOnce(rom, 0, SPRITE_SEED, { atRest: true })
    expect(m.refusal).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x88, y: 0x80, rawX: 0x80, rawY: 0x80 })
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
    expect(m.anchor).toMatchObject({ x: 0x148, y: 0x90, rawX: 0x140, rawY: 0x90 })
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
    it(
      `every $${id.toString(16)} on map $${map.toString(16)} is drawn on its line (odd column) or stays on its tile (even column, never appears), D156`,
      slow(15_000),
      () => {
        const got = placed(map, id)
        expect(got.length).toBeGreaterThan(0)
        let n = 0
        for (const { s, r } of got) {
          if (!('m' in r)) throw new Error('direct answer')
          expect(r.m.refusal).toBeUndefined()
          // The oracle is InitLineGuidedSpr (bank_01.asm:11788-11809): bit 4 of X clear subtracts $140, set adds $0F. D156:
          // an odd column starts ahead of the scroll and is drawn on its line (INIT's spot is `initAt`); an even column
          // starts behind it in every spawn, so it stays on its stored tile.
          expect(r.m.anchor).toMatchObject({ rawX: s.x * 16, rawY: s.y * 16 })
          if ((s.x * 16) & 0x10) {
            expect(r.m.shifted).toBe(true)
            expect(r.m.initAt).toEqual({ x: s.x * 16 + 15, y: s.y * 16 })
          } else {
            expect(r.m.neverAppears).toBe(true)
            expect([r.m.anchor?.x, r.m.anchor?.y]).toEqual([s.x * 16, s.y * 16])
            expect(r.m.shifted).toBeUndefined()
          }
          if (r.m.chosen !== undefined) n++
          else expect(r.m.emptyReason).toMatch(/drew no OAM tile/)
        }
        expect(n).toBe(drawn)
      },
    )
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
  it('the same INIT on an id that is not line-guided (31) is drawn where INIT left it too, by the general rule (#1231)', () => {
    const m = runOnce(shifting, 31, SPRITE_SEED, opts)
    expect(m.snaps).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x88, y: 0x80, rawX: 0x80 })
    expect(m.shifted).toBe(true)
  })
  it('a handler the gate refuses (not the stock calls) is drawn by the general rule: where INIT left it, no line walk', () => {
    const altered = buildSyntheticRom({ grinderInitShifts: true, alteredGrinder: true })
    const m = runOnce(altered, 103, SPRITE_SEED, { atRest: true, grinderDispatch: grinderShape(altered) }) // prettier-ignore
    expect(m.snaps).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x88, y: 0x80, rawX: 0x80 })
    expect(m.shifted).toBe(true)
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

  it('a sprite moved only by its first step is not flagged: its INIT did not move it, so the INIT is not checked', () => {
    // {grinderDrawsFromPass1}: INIT is a bare return, which no stock list names; before the fix this was flagged.
    const alone = rest({ grinderDrawsFromPass1: true })
    expect(alone.shifted).toBe(true)
    expect(alone.lineInitReason).toBeUndefined()
    expect((modelResult(alone) as { unverified?: string }).unverified ?? '').not.toMatch(/INIT/)
    // A $62 (list id 98) whose INIT does not move it but whose first draw is on pass 1: also not flagged, and with a
    // stock list that does not name its INIT.
    const rom = buildSyntheticRom({ grinderAliases: true, grinderDrawsFromPass1: true })
    const sixtytwo = runOnce(rom, 98, SPRITE_SEED, { atRest: true, grinderDispatch: grinderShape(rom), stockInits: [] }) // prettier-ignore
    expect(sixtytwo.shifted).toBe(true)
    expect(sixtytwo.lineInitReason).toBeUndefined()
    // The same $62 with an INIT that does move it, and a stock list that does not name it, is flagged.
    const moved = buildSyntheticRom({ grinderAliases: true, grinderInitDelta: [8, 0] })
    const flagged = runOnce(moved, 98, SPRITE_SEED, { atRest: true, grinderDispatch: grinderShape(moved), stockInits: [] }) // prettier-ignore
    expect(flagged.lineInitReason).toMatch(/not a stock line-guided INIT/)
  })

  it('a gate that refuses a sprite whose INIT moves it draws it where INIT left it, with the stored tile, and says it is unchecked (CodeRabbit)', () => {
    const rom = buildSyntheticRom({ grinderInitShifts: true, alteredGrinder: true })
    const m = runOnce(rom, 103, SPRITE_SEED, { atRest: true, grinderDispatch: grinderShape(rom) })
    expect(m.lineGateReason).toMatch(/out of order/)
    expect(m.anchor).toMatchObject({ x: 0x88, y: 0x80 }) // the general rule: where INIT left it
    expect(m.initMoved).toBe(true)
    const res = modelResult(m) as { unverified?: string; stored?: unknown }
    expect(res.unverified).toMatch(
      /drawn where its start-up code leaves it, not checked against the stock line-guided code: .*out of order/,
    )
    expect(res.stored).toEqual({ x: 0x80, y: 0x80 })
    // A refused sprite whose INIT does not move it has nothing to qualify.
    const still = buildSyntheticRom({ alteredGrinder: true })
    const m2 = runOnce(still, 103, SPRITE_SEED, {
      atRest: true,
      grinderDispatch: grinderShape(still),
    })
    expect(m2.lineGateReason).toBeDefined()
    expect(m2.initMoved).toBeUndefined()
    expect((modelResult(m2) as { unverified?: string }).unverified ?? '').not.toMatch(/start-up/)
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
  'which sprites are drawn away from their list position (R16, #1231)',
  () => {
    const sweep = (x: number) => {
      const r = RomFile.load(romPath(VANILLA))
      const got = new Map<number, string>()
      for (let id = 0; id <= 0xc8; id++) {
        const m = runOnce(r, id, withSeed({ slot: 3, sprite: { x, y: 0x80 } }, SPRITE_SEED), { atRest: true }) // prettier-ignore
        if (m.chosen === undefined || !m.anchor) continue
        const off = m.anchor.x !== m.anchor.rawX || m.anchor.y !== m.anchor.rawY
        // What moves a picture off its list position is the run: no id decides it, and the model says so by itself.
        expect(m.shifted === true || m.neverAppears === true, `id ${id}`).toBe(off || m.neverAppears === true) // prettier-ignore
        if (m.neverAppears) got.set(id, 'never appears')
        else if (off) got.set(id, `${m.anchor.x - x},${m.anchor.y - 0x80}`)
      }
      return Object.fromEntries([...got].map(([id, d]) => [`$${id.toString(16)}`, d]))
    }
    // The same cart, generic slot-3 seed, one machine: the offset each sprite's INIT gives it, found by running it. $65-$67 at the
    // even column start behind the scroll (D156) and stay on their tile; $68 is not erased offscreen, so it appears 320 px left.
    // The seed has no loaded level, so INIT reads the generic state (the platforms that drop 384 px read a water or ground cell).
    const COMMON = { $e: '8,0', $1a: '8,-1', $26: '8,0', $2a: '8,-17', $3c: '0,1', $4b: '8,-1', $4f: '8,-1', $50: '8,-1', $52: '0,-1', $5b: '0,384', $5d: '0,384', $5f: '120,104', $63: '2,0', $64: '2,0', $6c: '-8,0', $a4: '0,384', $ac: '0,-64', $c0: '0,2' } // prettier-ignore
    it('even column: every sprite the run moves, by how much', () => {
      expect(sweep(0x80)).toEqual({ ...COMMON, $29: '-8,192', $65: 'never appears', $66: 'never appears', $67: 'never appears', $68: '-320,0', $82: '32,112' }) // prettier-ignore
    })
    it('odd column: the line-guided ids start ahead of the scroll and draw 15 px right; $29, which writes its own X and Y, lands elsewhere than in the even column', () => {
      expect(sweep(0x90)).toEqual({ ...COMMON, $29: '-24,192', $65: '15,0', $66: '15,0', $67: '15,0', $68: '15,0', $82: '16,112' }) // prettier-ignore
    })
  },
)

describe('a sprite INIT moves off the screen it was run on (camera re-run)', () => {
  // INIT adds 256 px to X and MAIN draws only on screen, as GetDrawInfo does: the first run culls it.
  const far = buildSyntheticRom({ initFarCull: true })
  it('still draws its tile, where INIT left it, not the marker (D139 D, #1231)', () => {
    const m = runOnce(far, 0, SPRITE_SEED, { atRest: true })
    expect(m.emptyReason).toBeUndefined()
    expect(m.chosen).toBe(0)
    expect(m.anchor).toMatchObject({ x: 0x188, y: 0x80, rawX: 0x80, rawY: 0x80 })
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
  it('draws the full picture when MAIN moves it partway back before drawing (a Podoboo)', () => {
    const m = runOnce(buildSyntheticRom({ initFarCull: true, mainStepsBack: true }), 0, SPRITE_SEED, { atRest: true }) // prettier-ignore
    expect(m.chosen).toBe(0)
    expect(m.anchor).toMatchObject({ x: 0x188, y: 0x80, rawX: 0x80 })
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
  // The drawing stands where INIT left the sprite (#1231); id 0's INIT adds 8 to X.
  const s20 = { ...s, spriteId: 20 } as LevelSprite
  it("interpRunner draws INIT's picture where INIT left it", () => {
    const m = ran(interpRunner(rom, 0, shape, undefined, () => base)(s))
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 136, y: 128, rawX: 128, rawY: 128 })
    expect(ran(interpRunner(rom, 0, shape, undefined, () => base)(s20)).passes[0]!.palette.length).toBeGreaterThan(0) // prettier-ignore
  })
  it("the frames of a sprite are run with INIT's picture where INIT left it", () => {
    const m = ran(frameRun(rom, 0, shape, base, s))
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 136, y: 128 })
    expect(ran(frameRun(rom, 0, shape, base, s20)).passes[0]!.palette.length).toBeGreaterThan(0)
  })
})

describe('the D139 picture', () => {
  it('a sprite INIT moved (id 0: +8) stays where INIT left it, its look kept', () => {
    const m = runOnce(rom, 0, SPRITE_SEED, { atRest: true })
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 0x88, rawX: 0x80 })
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
})

describe('at rest, a handler that moves in MAIN (#1131)', () => {
  // Ids 37 and 38 move by ($0E, $0F) in MAIN, 37 after its draw and 38 before; 39 lifts Y by 16 around its draw and
  // 40 then moves X by +4; 32 draws from its second pass on and moves X by +4 after each draw.
  const moving = (dx: number, dy: number) => withSeed({ ram: { 0x0e: dx, 0x0f: dy } })
  const MOVES = [[4, 0], [0, 4], [3, 5], [7, 2], [0, 0]] as const // prettier-ignore
  for (const [dx, dy] of MOVES) {
    it(`draws before a move of (${dx}, ${dy}): the picture sits at the pass's own origin`, () => {
      const m = runOnce(rom, 37, moving(dx, dy), { atRest: true })
      expect(m.refusal).toBeUndefined()
      expect(m.passes[0]!.pos).toEqual({ x: 0x80 + dx, y: 0x80 + dy })
      expect(m.passes[0]!.origin).toEqual({ x: 0x80, y: 0x80 })
      expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
    })
    it(`moves (${dx}, ${dy}) before the draw: the picture keeps the move (the Podoboo jump)`, () => {
      const m = runOnce(rom, 38, moving(dx, dy), { atRest: true })
      expect(m.refusal).toBeUndefined()
      expect(m.passes[0]!.origin).toEqual(m.passes[0]!.pos)
      expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
    })
  }
  it('lifts Y for the draw and restores it: the picture keeps the end-of-pass spot (id 39)', () => {
    const m = runOnce(rom, 39, SPRITE_SEED, { atRest: true })
    expect(m.refusal).toBeUndefined()
    expect(m.passes[0]!.drawPos!.y).toBe(m.passes[0]!.pos.y - 16)
    expect(m.passes[0]!.origin).toEqual(m.passes[0]!.pos)
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: -16 })
  })
  it('a displaced draw followed by a move cannot be told from a move first: the end of the pass stands (id 40)', () => {
    const m = runOnce(rom, 40, SPRITE_SEED, { atRest: true })
    expect(m.passes[0]!.drawPos!.y).toBe(m.passes[0]!.pos.y - 16)
    expect(m.passes[0]!.origin).toEqual(m.passes[0]!.pos)
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: -4, dy: -16 })
  })
  it('a pass that draws nothing keeps the end of the pass; a later pass measures from where it began (id 32)', () => {
    const m = runOnce(rom, 32, SPRITE_SEED, { atRest: true })
    expect(m.chosen).toBe(1)
    expect(m.passes[0]!.drawPos).toBeUndefined()
    expect(m.passes[0]!.origin).toEqual(m.passes[0]!.pos)
    expect(m.passes[1]!.drawPos).toEqual(m.passes[0]!.pos)
    expect(m.passes[1]!.origin).toEqual(m.passes[0]!.pos)
    expect(m.passes[1]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
})
