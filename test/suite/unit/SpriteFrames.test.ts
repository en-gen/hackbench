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
import {
  framesOf,
  MAX_FRAMES,
  mapSpriteFrames,
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
const part = (char: number, dx = 0, flipX = false): SpritePart => ({ oam: 0, char, size: 8, palette: 9, priority: 2, flipX, flipY: false, dx, dy: 0, attr: 0, ox: 0, oy: 0 }) // prettier-ignore
/** One pass per `[char, drift]`: the sprite walks `drift` px right and its parts dx carry that drift. */
const run = (poses: [number, number][]): SpriteModel => ({
  id: 0x10,
  anchor: { x: 80, y: 48, rawX: 80, rawY: 48 },
  chosen: 0,
  dependsOn: [],
  steps: [],
  passes: poses.map(([c, drift], i) => ({
    pass: i,
    pos: { x: 80 + drift, y: 48 },
    origin: { x: 80, y: 48 },
    parts: [part(c, drift)],
    uploads: [],
    palette: [],
  })),
})
const frames = (poses: [number, number][], fixed = false) => framesOf({ m: run(poses), fixed }, spr, LEVEL) // prettier-ignore

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
})
