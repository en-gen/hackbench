/**
 * #840: the map view draws companions with their spawner (D52), and every reader of a pass that draws goes through
 * `drawnParts`. Synthetic passes and carts, so CI needs no ROM; the vanilla witnesses are gated on the corpus.
 * Evidence scope (corpus block): vanilla ROM, one machine, 2026-11-04.
 */
import { readFileSync } from 'fs'
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { fiveEeries, spawnerEntry } from '../../../../src/rom/sprites/interp/FiveEeries'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runSpawnedChildren } from '../../../../src/rom/sprites/interp/SpawnedChildren'
import {
  drawnParts,
  Machine,
  RAM,
  runOnce,
  type PassResult,
  type SpriteModel,
  type SpritePart,
} from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import {
  frameRun,
  framesOf,
  interpParts,
  interpRunner,
  readStream,
  type RunModel,
} from '../../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../../support/corpus'
import { COLORS } from '../../support/mapInputs'
import { eeriesSeed, SYNTHETIC_EERIES_ROUTINES } from '../../support/syntheticEeries'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const SOLID = new Uint8Array(64).fill(1)
const LEVEL = { vram: { sp1: Array.from({ length: 24 }, () => SOLID) }, colors: COLORS }
const spr = { index: 3, x: 5, y: 3, spriteId: 0x10, screen: 0, extraBit: false, raw: [0, 0, 0], streamOffset: 0 } as LevelSprite // prettier-ignore
const piece = (char: number, dx = 0, ox = 0, oy = 0): SpritePart => ({ oam: char, char, size: 8, palette: 9, priority: 2, flipX: false, flipY: false, dx, dy: 0, attr: 0, ox, oy }) // prettier-ignore
const pass = (n: number, parts: SpritePart[], companions: SpritePart[]): PassResult => ({
  pass: n,
  pos: { x: 80, y: 48 },
  origin: { x: 80, y: 48 },
  parts,
  companions,
  uploads: [],
  palette: [],
})
const model = (passes: PassResult[]): RunModel => ({
  id: 0x10,
  anchor: { x: 80, y: 48, rawX: 80, rawY: 48 },
  chosen: 0,
  dependsOn: [],
  steps: [],
  passes,
})

describe('framesOf with companions', () => {
  it('a frame holds the sprite and its companion, each once', () => {
    const m = model([pass(0, [piece(1)], [piece(2, 16)])])
    const [f] = framesOf({ m, fixed: false }, spr, LEVEL).frames
    expect(f!.parts!.map(p => p.char).sort()).toEqual([0x401, 0x402])
  })

  it('a pass that differs only in its companion is another pose', () => {
    const m = model([pass(0, [piece(1)], [piece(2, 16)]), pass(1, [piece(1)], [piece(3, 16)])])
    expect(framesOf({ m, fixed: false }, spr, LEVEL).frames).toHaveLength(2)
  })

  it('a spawner with no parts of its own is still a frame', () => {
    const m = model([pass(0, [], [piece(2, 16)])])
    expect(framesOf({ m, fixed: false }, spr, LEVEL).frames).toHaveLength(1)
  })
})

describe('screen-fixed pieces (fixOffsets) include companions', () => {
  // A cart-less run: the drawer only reads the run's model, the loader image and the camera.
  const loaded = new Uint8Array(0x20000)
  loaded.set([0x30, 0], 0x1a) // loader camera X 48
  loaded[0x1938 + 3] = 1 // sprite index 3 was loaded by the start-of-level load
  const base = withSeed({ loaded })
  // OAM X 40, Y 60 whatever the camera: screen-fixed. The sprite has no part of its own.
  const fake = () => model([pass(0, [], [piece(7, 0, 40, 60)])])

  it('a companion that does not follow the camera is placed from the loader camera, once', () => {
    const r = interpRunner({} as RomFile, 0, { isVertical: false, screenCount: 2 }, fake, () => base)(spr) // prettier-ignore
    if (!('m' in r)) throw new Error('direct')
    expect(r.fixed).toBe(true)
    const drawn = drawnParts(r.m.passes[0]!)
    expect(drawn).toHaveLength(1)
    expect(drawn[0]!.dx).toBe(40 + 48 - 80)
  })
})

describe('spawn readers include companions', () => {
  const rom = buildSyntheticRom({ eeries: {} })
  const seed = eeriesSeed(100, { camera: { x: 700, y: 224 }, mario: { x: 100, y: 0 } })
  const entry = { x: 832, y: 368, index: 9, streamOffset: 0 }
  // The same runs with every piece moved from parts to companions: a reader of `parts` alone sees nothing.
  const asCompanions = (
    r: RomFile,
    id: number,
    s: Parameters<typeof runOnce>[2],
    o?: Parameters<typeof runOnce>[3],
  ): SpriteModel => {
    // prettier-ignore
    const m = runOnce(r, id, s, o)
    return { ...m, passes: m.passes.map(p => ({ ...p, companions: p.parts, parts: [] })) }
  }
  it('fiveEeries keeps the five pieces', () => {
    const r = fiveEeries(rom, seed, entry, SYNTHETIC_EERIES_ROUTINES, 1, asCompanions)
    if (!r.ok) throw new Error(r.reason)
    expect(r.parts).toHaveLength(5)
  })
  it('runSpawnedChildren keeps the five children', () => {
    const routine = spawnerEntry(rom)!
    const r = runSpawnedChildren(rom, seed, entry, { sprite: 0x39, count: 5, routine }, 1, asCompanions) // prettier-ignore
    expect(r.children.map(c => c.parts.length)).toEqual([1, 1, 1, 1, 1])
  })
})

describe('the machine keeps companion writes per pass', () => {
  it('a pass starts with none', () => {
    const m = new Machine(buildSyntheticRom(), withSeed({ slot: 5 }), 5)
    m.bus.wram[0x15e9] = 4
    m.bus.write(0x7e0000 + RAM.oam + 2 + 4 * 20, 0x24)
    expect(m.companionOam()).toEqual([20])
    m.clearOamWrites()
    expect(m.companionOam()).toEqual([])
  })
})

describe.skipIf(!hasRom(VANILLA))('the map view equals develop on vanilla maps (#840)', () => {
  const flags = { yellow: false, green: false, red: false, blue: false }
  const open = (map: number) => {
    const b = new Uint8Array(readFileSync(romPath(VANILLA)))
    const built = new L1ModelCache().get(b, romPath(VANILLA), map, flags)
    if (!built.ok) throw new Error(built.reason)
    const smw = new SmwRom(RomFile.fromBytes(romPath(VANILLA), Buffer.from(b)))
    const list = parseLevelSprites(readStream(smw.rom, smw.getLevelSpritePointer(map)!), built.inputs.isVertical) // prettier-ignore
    return { rom: smw.rom, inputs: built.inputs, list, base: levelSeed(smw.rom, map) }
  }
  const cellsOf = (m: SpriteModel) => interpParts(drawnParts(m.passes[m.chosen!]!)).length
  const run = (o: ReturnType<typeof open>, map: number, s: LevelSprite, list: LevelSprite[]) => {
    const r = interpRunner(o.rom, map, o.inputs, undefined, () => o.base, undefined, undefined, undefined, list)(s) // prettier-ignore
    if (!('m' in r)) throw new Error('direct')
    return r.m
  }
  const at = (id: number, screen: number, x: number, y: number, index = 99): LevelSprite =>
    ({ index, x, y, spriteId: id, screen, extraBit: false, raw: [0, 0, 0], streamOffset: 0 }) as LevelSprite // prettier-ignore

  it.each([
    [8, 16, 0],
    [3, 20, 1],
    [10, 7, 2],
    [2, 14, 3],
  ])(
    'bonus game $82 on map 1d3 at list spot %i,%i (screen %i): 58 cells, the neighbour run changes nothing',
    (x, y, screen) => {
      const o = open(0x1d3)
      const s = at(0x82, screen, x, y)
      const m = run(o, 0x1d3, s, [...o.list, s])
      expect(m.neighbourRun).toBe('same')
      expect(cellsOf(m)).toBe(58)
    },
  )

  it.each([0x61, 0x1e])('$9C at list index 10 on map 6 with sprite %i beside it: 26 cells', id => {
    const o = open(0x006)
    const hammer = o.list[10]!
    expect(hammer.spriteId).toBe(0x9c)
    const beside = at(id, hammer.screen, hammer.x, hammer.y)
    expect(cellsOf(run(o, 0x006, hammer, [...o.list, beside]))).toBe(26)
  })

  it('$2B at screen 0, 8,16 on map 105 gives 7 frames', () => {
    const o = open(0x105)
    const s = at(0x2b, 0, 8, 16, 0)
    const r = frameRun(o.rom, 0x105, o.inputs, o.base, s, [])
    expect(framesOf(r, s, o.inputs as never).frames).toHaveLength(7)
  })
})
