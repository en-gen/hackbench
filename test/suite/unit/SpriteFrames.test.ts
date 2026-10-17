/**
 * #984: the Properties preview's frames. Node half (`framesOf`) and browser half (`FramePlayer`) run on
 * synthetic passes and DTOs, so CI needs no cart; the vanilla block is gated on the corpus.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { parseLevelSprites } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import type { SpriteModel, SpritePart } from '../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed, type SpriteSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import {
  drawSprites,
  framesOf,
  interpRunner,
  MAX_FRAMES,
  mapSpriteFrames,
  mapSprites,
  modelResult,
  readStream,
} from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import {
  FramePlayer,
  FRAME_STEP_MS,
  type Clock,
} from '../../../theia/extension/src/browser/sprite-frames'
import type {
  MapSpriteDto,
  SpriteFramesResult,
} from '../../../theia/extension/src/common/project-protocol'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { COLORS } from '../support/mapInputs'
import { slow } from '../support/loadTimeout'

const SOLID = new Uint8Array(64).fill(1)
const LEVEL = { vram: { sp1: Array.from({ length: 24 }, () => SOLID) }, colors: COLORS }
const spr = { index: 3, x: 5, y: 3, spriteId: 0x10, screen: 0, extraBit: false, raw: [0, 0, 0], streamOffset: 0 } as LevelSprite // prettier-ignore
const part = (char: number, dx = 0, flipX = false, dy = 0): SpritePart => ({ oam: 0, char, size: 8, palette: 9, priority: 2, flipX, flipY: false, dx, dy, attr: 0, ox: 0, oy: 0 }) // prettier-ignore
/** One pass per `[char, drift, driftY]`: the sprite walks right and down and its parts dx and dy carry that drift. */
const run = (poses: [number, number, number?][]): SpriteModel => ({
  id: 0x10,
  anchor: { x: 80, y: 48, rawX: 80, rawY: 48 },
  chosen: 0,
  dependsOn: [],
  steps: [],
  passes: poses.map(([c, drift, dy = 0], i) => ({
    pass: i,
    pos: { x: 80 + drift, y: 48 + dy },
    origin: { x: 80, y: 48 },
    parts: [part(c, drift, false, dy)],
    uploads: [],
    palette: [],
  })),
})
const frames = (poses: [number, number, number?][], fixed = false) => framesOf({ m: run(poses), fixed }, spr, LEVEL) // prettier-ignore

describe('framesOf', () => {
  it('two poses that also drift across passes are two frames, kept in pass order', () => {
    const f = frames([[1, 0], [1, 4], [2, 8], [1, 12], [2, 16]]).frames // prettier-ignore
    expect(f).toHaveLength(2)
    expect(f.map(x => x.parts![0]!.char)).toEqual([0x401, 0x402])
  })

  it('motion alone is not a pose: a sprite that only drifts is one frame', () => {
    expect(frames([[1, 0], [1, 5], [1, 9]]).frames).toHaveLength(1) // prettier-ignore
  })

  it('a flip is a different pose', () => {
    const m = run([[1, 0], [1, 0]]) // prettier-ignore
    m.passes[1]!.parts[0]!.flipX = true
    expect(framesOf({ m, fixed: false }, spr, LEVEL).frames).toHaveLength(2)
  })

  it('every frame is measured from the first drawn pass: the sprite movement is removed', () => {
    const f = frames([[1, 0], [2, 8], [1, 0], [3, 20]]).frames // prettier-ignore
    expect(f.map(x => x.box.x0)).toEqual([80, 80, 80])
    expect(f.map(x => x.parts![0]!.dx)).toEqual([0, 0, 0])
  })

  it('the sprite movement in Y is removed too: a sprite that drifts down is one frame, boxes level', () => {
    const f = frames([
      [1, 0, 0],
      [2, 0, 6],
      [1, 0, 13],
    ]).frames
    expect(f.map(x => x.box.y0)).toEqual([48, 48])
    expect(f.map(x => x.parts![0]!.dy)).toEqual([0, 0])
  })

  it('parts that move against each other are a new pose though the chars are the same', () => {
    const two = (gap: number, drift: number): SpritePart[] => [part(1, drift), part(2, drift + gap)]
    const m = run([
      [1, 0],
      [1, 3],
      [1, 7],
    ])
    m.passes[0]!.parts = two(8, 0)
    m.passes[1]!.parts = two(12, 3) // the second part swings out: a real pose change
    m.passes[2]!.parts = two(8, 7) // back, and the whole sprite has drifted: pose 0 again
    const f = framesOf({ m, fixed: false }, spr, LEVEL).frames
    expect(f).toHaveLength(2)
    expect(f[1]!.box.x1 - f[1]!.box.x0).toBeGreaterThan(f[0]!.box.x1 - f[0]!.box.x0)
  })

  it('a pose that is the same shape drifting is not a new pose', () => {
    const two = (drift: number): SpritePart[] => [part(1, drift), part(2, drift + 8)]
    const m = run([
      [1, 0],
      [1, 5],
    ])
    m.passes[0]!.parts = two(0)
    m.passes[1]!.parts = two(5)
    expect(framesOf({ m, fixed: false }, spr, LEVEL).frames).toHaveLength(1)
  })

  it('keeps at most MAX_FRAMES poses', () => {
    const f = frames(Array.from({ length: 24 }, (_, i) => [i, 0] as [number, number])).frames
    expect(f).toHaveLength(MAX_FRAMES)
  })

  it('a run that drew nothing is not animated, with its reason, never an error', () => {
    const m = { ...run([]), chosen: undefined, emptyReason: 'drew no OAM tile' }
    expect(framesOf({ m, fixed: false }, spr, LEVEL)).toEqual({ frames: [], reason: 'drew no OAM tile' }) // prettier-ignore
    const refused = { ...m, refusal: 'no handler' }
    expect(framesOf({ m: refused, fixed: false }, spr, LEVEL).reason).toBe('refused: no handler')
  })

  it('screen-fixed parts are not animated', () => {
    expect(frames([[1, 0], [2, 0]], true)).toEqual({ frames: [], reason: 'its parts are fixed to the screen' }) // prettier-ignore
  })
})

describe('framesOf on a $67-style run (parts measured from the pass before)', () => {
  // The draw runs before the move: pass k draws where pass k-1 left the sprite (SpriteRunner `snaps`).
  // pos by pass: 84, 90, 99, 103; the art is the same for passes 0-2 and changes on pass 3.
  const POS = [84, 90, 99, 103]
  const grinder = (chosen: number, chars = [1, 1, 1, 2]): SpriteModel => ({
    id: 0x67,
    anchor: { x: [80, ...POS][chosen]!, y: 48, rawX: 80, rawY: 48 },
    chosen,
    dependsOn: [],
    steps: [],
    passes: POS.map((x, i) => ({
      pass: i,
      pos: { x, y: 48 },
      origin: { x: [80, ...POS][i]!, y: 48 },
      parts: [part(chars[i]!, 0)],
      uploads: [],
      palette: [],
    })),
  })

  it.each([1, 2])('frame 0 is the pose the map draws (chosen pass %i), not an earlier pass', c => {
    const m = grinder(c)
    const [mapDto] = drawSprites([spr], LEVEL, () => modelResult(m))
    const f = framesOf({ m, fixed: false }, spr, LEVEL).frames
    expect(f[0]).toEqual(mapDto)
    expect(f).toHaveLength(2) // the chosen art, then the pass-3 art
  })

  it('uneven steps between passes do not shift the art: every frame sits on the chosen anchor', () => {
    const f = framesOf({ m: grinder(1), fixed: false }, spr, LEVEL).frames
    expect(f.map(x => x.box.x0)).toEqual([84, 84])
  })
})

describe('interpRunner reports screen-fixed parts', () => {
  const blank = RomFile.fromBytes('blank.sfc', Buffer.alloc(0x80000))
  const loaded = (status: number[]) => {
    const w = new Uint8Array(0x2000)
    w.set([0, 0, 0xc0, 0], 0x1a) // Layer 1 at (0, 192), as the loader left it
    for (const i of status) w[0x1938 + i] = 1
    return withSeed({ loaded: w })
  }
  const at = { index: 0, x: 8, y: 7, spriteId: 0x8c, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as LevelSprite // prettier-ignore
  type R = (r: RomFile, i: number, s: SpriteSeed) => SpriteModel
  // Part 0 ignores the camera (OAM 184,176); part 1 follows it.
  const runWith =
    (parts: (cam: { x: number; y: number }) => number[][]): R =>
    (_r, _i, seed) => {
      const { camera: c, sprite: sp } = seed
      const mk = ([oam, ox, oy]: number[]) => ({ ...part(0), oam: oam!, ox: ox!, oy: oy!, dx: ox! - (sp.x - c.x), dy: oy! - (sp.y - c.y) }) // prettier-ignore
      const passes = Array.from({ length: seed.mainPasses }, (_, pass) => ({ pass, pos: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, parts: pass === 0 ? parts(c).map(mk) : [], uploads: [], palette: [] })) // prettier-ignore
      return { id: 0x8c, anchor: { x: sp.x, y: sp.y, rawX: sp.x, rawY: sp.y }, passes, chosen: 0, dependsOn: [], steps: [] } // prettier-ignore
    }
  const go = (r: R, status = [0]) => interpRunner(blank, 0x104, { isVertical: false, screenCount: 2 }, r, () => loaded(status))(at) // prettier-ignore

  it('fixed is true when a part ignores the camera, with the parts moved onto the map', () => {
    const r = go(
      runWith(c => [
        [0, 184, 176],
        [1, 132 - c.x, 120 - c.y],
      ]),
    )
    expect(r.fixed).toBe(true)
    expect(r.m.passes[0]!.parts[0]!.dx).toBe(184 - 8 * 16 + 0)
  })

  it('fixed is false for a camera-following sprite, and for one the loader did not load', () => {
    expect(go(runWith(c => [[1, 132 - c.x, 120 - c.y]])).fixed).toBe(false)
    expect(
      go(
        runWith(() => [[0, 184, 176]]),
        [],
      ).fixed,
    ).toBe(false)
  })
})

describe('mapSpriteFrames without a cart', () => {
  it('a ROM that holds no such map answers unavailable with a reason, never throws', () => {
    const r = mapSpriteFrames(new L1ModelCache(), new Uint8Array(0x80000), 'blank.sfc', 0x105, 0)
    expect(r.status).toBe('unavailable')
    expect(r.status === 'unavailable' && r.reason.length).toBeGreaterThan(0)
  })
})

describe('FramePlayer', () => {
  const dto = (n: number) => ({ index: n }) as MapSpriteDto
  const ok = (n: number): SpriteFramesResult => ({ status: 'ok', frames: Array.from({ length: n }, (_, i) => dto(i)) }) // prettier-ignore
  const src = { manifestPath: 'm', index: 1, spriteIndex: 0 }
  const flush = () => new Promise(r => setTimeout(r, 0))
  const fakeClock = () => {
    const c = { fn: undefined as (() => void) | undefined, ms: 0 }
    const clock: Clock = {
      every: (fn, ms) => {
        c.fn = fn
        c.ms = ms
        return 1
      },
      stop: () => {
        c.fn = undefined
      },
    }
    return { c, clock }
  }

  it('two or more frames play, stepping every FRAME_STEP_MS and wrapping', async () => {
    const { c, clock } = fakeClock()
    const p = new FramePlayer(async () => ok(3), clock)
    p.select(src)
    await flush()
    expect(c.ms).toBe(FRAME_STEP_MS)
    const at = () => (p.state.kind === 'playing' ? p.state.current : -1)
    const seen = [at()]
    for (let i = 0; i < 3; i++) {
      c.fn!()
      seen.push(at())
    }
    expect(seen).toEqual([0, 1, 2, 0])
  })

  it('one frame, an error or an unavailable reply is "still", with the reason', async () => {
    const { clock } = fakeClock()
    for (const r of [ok(1), { status: 'unavailable', reason: 'why' } as SpriteFramesResult]) {
      const p = new FramePlayer(async () => r, clock)
      p.select(src)
      await flush()
      expect(p.state.kind).toBe('still')
    }
    const p = new FramePlayer(() => Promise.reject(new Error('boom')), clock)
    p.select(src)
    await flush()
    expect(p.state).toEqual({ kind: 'still', reason: 'boom' })
  })

  it('a reply for a sprite that is no longer selected is ignored', async () => {
    const { c, clock } = fakeClock()
    const late: ((r: SpriteFramesResult) => void)[] = []
    const p = new FramePlayer(() => new Promise(res => late.push(res)), clock)
    p.select(src)
    p.select({ ...src, spriteIndex: 1 })
    late[0]!(ok(3))
    await flush()
    expect(p.state.kind).toBe('loading')
    expect(c.fn).toBeUndefined()
    late[1]!(ok(2))
    await flush()
    expect(p.state.kind).toBe('playing')
  })

  it('a rejection for a sprite that is no longer selected is ignored too', async () => {
    const { clock } = fakeClock()
    const fail: ((e: Error) => void)[] = []
    const p = new FramePlayer(() => new Promise((_, rej) => fail.push(rej)), clock)
    p.select(src)
    p.select({ ...src, spriteIndex: 1 })
    fail[0]!(new Error('late'))
    await flush()
    expect(p.state.kind).toBe('loading')
    p.select(undefined)
    fail[1]!(new Error('later'))
    await flush()
    expect(p.state.kind).toBe('idle')
  })

  it('frames that arrive while the panel is hidden do not start the timer until it is shown', async () => {
    const { c, clock } = fakeClock()
    const p = new FramePlayer(async () => ok(2), clock)
    p.setVisible(false)
    p.select(src)
    await flush()
    expect(p.state.kind).toBe('playing')
    expect(c.fn).toBeUndefined()
    p.setVisible(true)
    expect(c.fn).toBeDefined()
  })

  it('an unlocated ROM is "still" with a reason code the panel can put in words', async () => {
    const { clock } = fakeClock()
    const p = new FramePlayer(
      async () => ({ status: 'rom-not-located' }) as SpriteFramesResult,
      clock,
    )
    p.select(src)
    await flush()
    expect(p.state).toEqual({ kind: 'still', reason: 'rom-not-located' })
  })

  it('the timer stops on clear, on hide and on dispose; a late reply after clear starts none', async () => {
    const { c, clock } = fakeClock()
    const p = new FramePlayer(async () => ok(2), clock)
    p.select(src)
    await flush()
    expect(c.fn).toBeDefined()
    p.setVisible(false)
    expect(c.fn).toBeUndefined()
    p.setVisible(true)
    expect(c.fn).toBeDefined()
    p.select(undefined)
    expect(c.fn).toBeUndefined()
    expect(p.state.kind).toBe('idle')
    p.select(src)
    await flush()
    expect(c.fn).toBeDefined()
    p.dispose()
    expect(c.fn).toBeUndefined()
    let resolve!: (r: SpriteFramesResult) => void
    const q = new FramePlayer(() => new Promise(r => (resolve = r)), clock)
    q.select(src)
    q.select(undefined)
    resolve(ok(2))
    await flush()
    expect(c.fn).toBeUndefined()
  })
})

describe.skipIf(!hasRom(VANILLA))('mapSpriteFrames on a vanilla map', () => {
  // prettier-ignore
  it('a Koopa ($04) has 2 or more frames; a static sprite ($9F) has at most 1', slow(60_000), () => {
    const bytes = new Uint8Array(readFileSync(romPath(VANILLA)))
    const cache = new L1ModelCache()
    const flags = { yellow: false, green: false, red: false, blue: false }
    const best = new Map<number, number>()
    for (const map of [0x0c7, 0x105]) {
      const built = cache.get(bytes, romPath(VANILLA), map, flags)
      if (!built.ok) continue
      const rom = new SmwRom(RomFile.fromBytes('v.sfc', Buffer.from(bytes)))
      const data = readStream(rom.rom, rom.getLevelSpritePointer(map)!)
      for (const s of parseLevelSprites(data, built.inputs.isVertical)) {
        if (s.spriteId !== 0x04 && s.spriteId !== 0x9f) continue
        const r = mapSpriteFrames(cache, bytes, romPath(VANILLA), map, s.index)
        if (r.status === 'ok') best.set(s.spriteId, Math.max(best.get(s.spriteId) ?? 0, r.frames.length))
      }
    }
    expect(best.get(0x04)).toBeGreaterThanOrEqual(2)
    expect(best.get(0x9f) ?? 0).toBeLessThanOrEqual(1)
  })
  // prettier-ignore
  it('every $67 grinder: frame 0 is the bitmap the map draws', slow(120_000), () => {
    const bytes = new Uint8Array(readFileSync(romPath(VANILLA)))
    const cache = new L1ModelCache()
    const flags = { yellow: false, green: false, red: false, blue: false }
    let compared = 0
    for (const map of [0x01a, 0x01f]) {
      const built = cache.get(bytes, romPath(VANILLA), map, flags)
      if (!built.ok) continue
      const drawn = mapSprites(cache, bytes, romPath(VANILLA), map)
      if (drawn.status !== 'ok') continue
      for (const d of drawn.sprites) {
        if (d.id !== 0x67 || d.status !== 'drawn' || d.fixedTo) continue
        const r = mapSpriteFrames(cache, bytes, romPath(VANILLA), map, d.index)
        if (r.status !== 'ok' || !r.frames.length) continue
        expect(r.frames[0]).toMatchObject({ box: d.box, rgba: d.rgba, parts: d.parts })
        compared++
      }
    }
    expect(compared, 'at least one $67 compared').toBeGreaterThan(0)
  })
})
