/**
 * The map tab's collision reply (en-gen/hackbench#435): `mapCollision` over the model cache, per working-copy
 * bytes. Synthetic maps for the refusals (a vertical level, a ROM whose loader refuses), the vanilla ROM for the
 * served path, the cache and the stale-reply rules.
 */
import { beforeEach, describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import type { collisionLayer, ProbeCache } from '../../../src/rom/collision/MapCollision'
import { NEUTRAL, type Probe } from '../../../src/rom/collision/TileProbe'
import {
  forgetCollisionCarry,
  mapCollision,
  mapCollisionCheck,
  probeStateOf,
} from '../../../theia/extension/src/node/map-collision'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { hGrid, inputs, vGrid } from '../support/mapInputs'
import { hasRom, romPath, VANILLA } from '../support/corpus'
import { readFileSync } from 'node:fs'

beforeEach(forgetCollisionCarry) // no case passes on an earlier case's carried cache

const OFF = NEUTRAL
const stub = (isVertical: boolean) =>
  new L1ModelCache(() => ({
    ok: true,
    inputs: inputs(isVertical ? vGrid(2) : hGrid(2), isVertical, 2),
  }))
const synthetic = () => {
  const b = new Uint8Array(0x80000)
  b[0x7fd5] = 0x20
  return b
}

describe('mapCollision (synthetic)', () => {
  it('a vertical level is unavailable with its reason, not an empty overlay', async () => {
    const r = await mapCollision(stub(true), synthetic(), 'x.sfc', 0x105, OFF)
    expect(r).toEqual({ status: 'unavailable', reason: expect.stringMatching(/vertical/i) })
  })

  it("a ROM the level loader refuses is unavailable with the loader's reason", async () => {
    const r = await mapCollision(stub(false), synthetic(), 'x.sfc', 0x105, OFF)
    expect(r).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(/not the vanilla shape/),
    })
  })

  it('a map the model cannot build is unavailable with that reason', async () => {
    const cache = new L1ModelCache(() => ({ ok: false, reason: 'no level data' }))
    expect(await mapCollision(cache, synthetic(), 'x.sfc', 0x105, OFF)).toEqual({ status: 'unavailable', reason: 'no level data' }) // prettier-ignore
  })
})

describe('mapCollision reply cache (synthetic layer)', () => {
  const lines = [{ kind: 'floor' as const, points: [0, 0, 16, 0] }]
  const layer = (script: ('ok' | 'bad')[]) => {
    const calls: number[] = []
    const fn = (async (_r: unknown, level: number) => {
      calls.push(level)
      const v = script.length ? script.shift()! : 'ok'
      return v === 'ok' ? { ok: true, lines, probed: 1, steps: 1 } : { ok: false, reason: 'hiccup' }
    }) as unknown as typeof import('../../../src/rom/collision/MapCollision').collisionLayer
    return { fn, calls }
  }
  /** A layer stub that hands the options it was called with (the sixth argument) to `f`. */
  const optsSpy = (f: (o: { cancelled?: () => boolean; state?: unknown }) => unknown) =>
    ((_r: unknown, _l: number, _t: number, _g: unknown, _p: unknown, o: object) =>
      Promise.resolve(f(o))) as unknown as ReturnType<typeof layer>['fn']
  const ask = (c: L1ModelCache, b: Uint8Array, i: number, fn: ReturnType<typeof layer>['fn']) =>
    mapCollision(c, b, 'x.sfc', i, OFF, () => false, fn)

  it('keeps an ok reply and does not keep an unavailable one', async () => {
    const [c, b, l] = [stub(false), synthetic(), layer(['bad'])]
    expect(await ask(c, b, 0x105, l.fn)).toEqual({ status: 'unavailable', reason: 'hiccup' })
    const ok = await ask(c, b, 0x105, l.fn) // asked again: not served the failure
    expect(ok.status).toBe('ok')
    expect(await ask(c, b, 0x105, l.fn)).toBe(ok) // now served from the cache
    expect(l.calls).toEqual([0x105, 0x105])
  })

  it('passes the cancel check to the layer and turns its stop into stale, kept nowhere', async () => {
    const [c, b] = [stub(false), synthetic()]
    const seen: (() => boolean)[] = []
    const stopped = optsSpy(o => {
      seen.push(o.cancelled!)
      return { ok: false, reason: 'superseded' }
    })
    expect(await mapCollision(c, b, 'x.sfc', 0x105, OFF, () => true, stopped)).toEqual({
      status: 'stale',
    })
    expect(seen[0]!()).toBe(true)
    expect((await ask(c, b, 0x105, layer([]).fn)).status).toBe('ok')
  })

  it('draws the grid with the view flags and probes in the same state; each state is its own reply', async () => {
    const seen: unknown[] = []
    const cache = new L1ModelCache((_r, _i, flags) => {
      seen.push(flags)
      return { ok: true, inputs: inputs(hGrid(2), false, 2) }
    })
    const states: unknown[] = []
    const fn = optsSpy(o => {
      states.push(o.state)
      return { ok: true, lines, probed: 1, steps: 1 }
    })
    const b = synthetic()
    const yellow = { flags: { ...OFF.flags, yellow: true }, bluePs: true }
    await mapCollision(cache, b, 'x.sfc', 0x15, yellow, () => false, fn)
    await mapCollision(cache, b, 'x.sfc', 0x15, OFF, () => false, fn)
    await mapCollision(cache, b, 'x.sfc', 0x15, yellow, () => false, fn) // same state again: cached
    expect(states).toEqual([yellow, OFF])
    expect(seen).toContainEqual(yellow.flags)
  })

  it('a request for another state of the same map supersedes the one still probing', async () => {
    const [c, b] = [stub(false), synthetic()]
    const yellow = { flags: { ...OFF.flags, yellow: true }, bluePs: false }
    let release!: () => void
    const gate = new Promise<void>(r => (release = r))
    const slow = (async (
      _r: unknown,
      _l: number,
      _t: number,
      _g: unknown,
      _p: unknown,
      o: { cancelled?: () => boolean },
    ) => {
      await gate
      return o.cancelled!()
        ? { ok: false, reason: 'superseded' }
        : { ok: true, lines, probed: 1, steps: 1 }
    }) as unknown as ReturnType<typeof layer>['fn']
    const first = mapCollision(c, b, 'x.sfc', 0x15, OFF, () => false, slow)
    const second = mapCollision(c, b, 'x.sfc', 0x15, yellow, () => false, slow)
    release()
    expect(await first).toEqual({ status: 'stale' })
    expect((await second).status).toBe('ok')
    // The same state asked twice shares one probe and neither is told it is stale.
    const [x, y] = [mapCollision(c, b, 'x.sfc', 0x16, OFF, () => false, slow), mapCollision(c, b, 'x.sfc', 0x16, OFF, () => false, slow)] // prettier-ignore
    expect([(await x).status, (await y).status]).toEqual(['ok', 'ok'])
  })

  it('the probe state is the view flags and the BLUE P-switch (not silver)', () => {
    const flags = { ...OFF.flags, red: true }
    expect(probeStateOf(flags, { blue: true, silver: false, onOff: false })).toEqual({
      flags,
      bluePs: true,
    })
    expect(probeStateOf(flags, { blue: false, silver: true, onOff: true }).bluePs).toBe(false)
  })

  it('keeps eight maps per working copy: the ninth evicts the least recently used', async () => {
    const [c, b, l] = [stub(false), synthetic(), layer([])]
    for (let i = 0; i < 8; i++) await ask(c, b, 0x100 + i, l.fn)
    await ask(c, b, 0x100, l.fn) // touch the oldest: it is now the newest
    await ask(c, b, 0x108, l.fn) // evicts 0x101
    l.calls.length = 0
    await ask(c, b, 0x100, l.fn)
    await ask(c, b, 0x108, l.fn)
    expect(l.calls).toEqual([])
    await ask(c, b, 0x101, l.fn)
    expect(l.calls).toEqual([0x101])
  })
})

describe('the cache carried across working-copy bytes (synthetic layer)', () => {
  // Fresh arrays per case (the module keys its caches on the array), each differing at its own byte.
  let [A, B, C] = [synthetic(), synthetic(), synthetic()]
  const fresh = () =>
    ([A, B, C] = [0, 1, 2].map(n => {
      const b = synthetic()
      b[0x200 + n * 0x100] = 1
      return b
    }) as [Uint8Array, Uint8Array, Uint8Array])
  // A layer that fills the cache the way a probe would (a tile and the shared prep, each with reads), and
  // reports what the cache it was handed holds.
  const seen: { stale: boolean; carried: boolean; dropped: number }[] = []
  const layer = (async (_r: unknown, _l: number, _t: number, _g: unknown, cache: ProbeCache) => {
    const carried = !!cache.get(7, 1)
    const stale = cache.stale(7)
    const dropped = cache.validate(7, { seed: () => 0 } as unknown as Probe)
    seen.push({ stale, carried, dropped })
    cache.setPrep(7, { cal: { foot: 32, head: 17 }, air: new Map(), deps: { rom: [0x100, 0x110], wram: [] } }) // prettier-ignore
    cache.set(7, 1, { floor: [], ceil: [], wallL: false, wallR: false, hurt: false }, undefined, { rom: [0x100, 0x101], wram: [] }) // prettier-ignore
    return { ok: true, lines: [], probed: 0, dropped: 0, steps: 0 }
  }) as unknown as typeof collisionLayer
  const ask = (b: Uint8Array, path = 'carry.sfc') =>
    mapCollision(stub(false), b, path, 0x105, OFF, () => false, layer)
  beforeEach(() => {
    seen.length = 0
    fresh()
  })

  it('new bytes of the same ROM inherit the previous bytes cache, owing the diff', async () => {
    await ask(A)
    await ask(B) // differs from A at $300 only: nothing read there
    expect(seen).toEqual([
      { stale: false, carried: false, dropped: 0 },
      { stale: true, carried: true, dropped: 0 },
    ])
  })

  it('an edit on a byte a tile read drops that tile when the next probe validates', async () => {
    const touched = new Uint8Array(A)
    touched[0x100] ^= 1 // inside the recorded read
    await ask(A)
    await ask(touched)
    expect(seen[1]).toMatchObject({ carried: true, dropped: 1 }) // the tile (its prep went too, which is why)
  })

  it('each new bytes inherits from the last asked, so a chain of edits carries on', async () => {
    await ask(A)
    await ask(B)
    await ask(C)
    expect(seen.map(s => s.carried)).toEqual([false, true, true])
  })

  it('another ROM path starts from nothing', async () => {
    await ask(A, 'one.sfc')
    await ask(B, 'two.sfc')
    expect(seen[1]).toMatchObject({ carried: false, stale: false })
  })
})

describe('mapCollisionCheck (synthetic): the toggle state without a probe', () => {
  it('says why for a vertical level, a refusing loader and an unbuildable map', () => {
    expect(mapCollisionCheck(stub(true), synthetic(), 'x.sfc', 0x105)).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(/vertical/i),
    })
    expect(mapCollisionCheck(stub(false), synthetic(), 'x.sfc', 0x105)).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(/not the vanilla shape/),
    })
    const broken = new L1ModelCache(() => ({ ok: false, reason: 'no level data' }))
    expect(mapCollisionCheck(broken, synthetic(), 'x.sfc', 0x105)).toEqual({ status: 'unavailable', reason: 'no level data' }) // prettier-ignore
  })
})

describe.skipIf(!hasRom(VANILLA))('mapCollisionCheck on the vanilla ROM', () => {
  it('is available and fast, and runs no probe: a planted BRK in the routine is not seen by it', () => {
    const bytes = new Uint8Array(readFileSync(romPath(VANILLA)))
    const t0 = Date.now()
    expect(mapCollisionCheck(new L1ModelCache(), bytes, romPath(VANILLA), 0x105)).toEqual({ status: 'available' }) // prettier-ignore
    expect(Date.now() - t0).toBeLessThan(2000)
    // A probe would hit the BRK; the check must not run one, so it still says available.
    const patched = RomFile.fromBytes(romPath(VANILLA), bytes)
    patched.writeAt(0x00eadb, [0x00])
    expect(mapCollisionCheck(new L1ModelCache(), patched.buffer, romPath(VANILLA), 0x105)).toEqual({ status: 'available' }) // prettier-ignore
  })
})

describe.skipIf(!hasRom(VANILLA))('mapCollision on the vanilla ROM', () => {
  const rom = () => new Uint8Array(readFileSync(romPath(VANILLA)))

  it('answers a map in its own pixels, once per working copy', async () => {
    const bytes = rom()
    const cache = new L1ModelCache()
    const t0 = Date.now()
    const r = await mapCollision(cache, bytes, romPath(VANILLA), 0x111, OFF)
    const cold = Date.now() - t0
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    expect([r.width, r.height]).toEqual([240 * 16, 27 * 16])
    expect(r.lines.some(l => l.kind === 'floor')).toBe(true)
    expect(cold).toBeLessThan(5000)
    const t1 = Date.now()
    expect(await mapCollision(cache, bytes, romPath(VANILLA), 0x111, OFF)).toBe(r) // the same reply object
    expect(Date.now() - t1).toBeLessThan(100)
  }, 120_000)

  it('new bytes are a new working copy: probed again, same lines for the same ROM', async () => {
    const a = rom()
    const cache = new L1ModelCache()
    const first = await mapCollision(cache, a, romPath(VANILLA), 0x111, OFF)
    const second = await mapCollision(cache, new Uint8Array(a), romPath(VANILLA), 0x111, OFF)
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  }, 120_000)

  it('an edit keeps the probe cache: a level-data move after a first reply probes at most the new ids', async () => {
    const a = rom()
    const cache = new L1ModelCache()
    const probed: number[] = []
    const real = (await import('../../../src/rom/collision/MapCollision')).collisionLayer
    const counting = (async (...args: Parameters<typeof real>) => {
      const r = await real(...args)
      if (r.ok) probed.push(r.probed)
      return r
    }) as typeof real
    const path = 'edit-keeps-cache.sfc' // its own path: earlier tests' bytes are not this cache's predecessors
    const ask = (b: Uint8Array) => mapCollision(cache, b, path, 0x111, OFF, () => false, counting)
    expect((await ask(a)).status).toBe('ok')
    const edited = new Uint8Array(a)
    edited[0x7ff00] ^= 0xff // a byte no probe run reads
    expect((await ask(edited)).status).toBe('ok')
    expect(probed[0]).toBeGreaterThan(20)
    expect(probed[1]).toBe(0)
  }, 120_000)

  it('a patched block routine changes what the working copy answers (here it breaks it: unavailable)', async () => {
    const patched = RomFile.fromBytes(romPath(VANILLA), rom())
    patched.writeAt(0x00eadb, [0x00]) // a BRK at the collision routine
    const r = await mapCollision(new L1ModelCache(), patched.buffer, romPath(VANILLA), 0x111, OFF)
    expect(r).toEqual({ status: 'unavailable', reason: expect.stringMatching(/BRK|calibration/) })
  }, 120_000)

  it('a stale request is abandoned and not kept: the next one is computed afresh', async () => {
    const bytes = rom()
    const cache = new L1ModelCache()
    const stale = await mapCollision(cache, bytes, romPath(VANILLA), 0x111, OFF, () => true)
    expect(stale).toEqual({ status: 'stale' })
    expect((await mapCollision(cache, bytes, romPath(VANILLA), 0x111, OFF)).status).toBe('ok')
  }, 120_000)
})
