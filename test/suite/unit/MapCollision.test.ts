/**
 * The map tab's collision reply (en-gen/hackbench#435): `mapCollision` over the model cache, per working-copy
 * bytes. Synthetic maps for the refusals (a vertical level, a ROM whose loader refuses), the vanilla ROM for the
 * served path, the cache and the stale-reply rules.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { mapCollision, mapCollisionCheck } from '../../../theia/extension/src/node/map-collision'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { hGrid, inputs, vGrid } from '../support/mapInputs'
import { hasRom, romPath, VANILLA } from '../support/corpus'
import { readFileSync } from 'node:fs'

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
    const r = await mapCollision(stub(true), synthetic(), 'x.sfc', 0x105)
    expect(r).toEqual({ status: 'unavailable', reason: expect.stringMatching(/vertical/i) })
  })

  it("a ROM the level loader refuses is unavailable with the loader's reason", async () => {
    const r = await mapCollision(stub(false), synthetic(), 'x.sfc', 0x105)
    expect(r).toEqual({
      status: 'unavailable',
      reason: expect.stringMatching(/not the vanilla shape/),
    })
  })

  it('a map the model cannot build is unavailable with that reason', async () => {
    const cache = new L1ModelCache(() => ({ ok: false, reason: 'no level data' }))
    expect(await mapCollision(cache, synthetic(), 'x.sfc', 0x105)).toEqual({ status: 'unavailable', reason: 'no level data' }) // prettier-ignore
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
    const r = await mapCollision(cache, bytes, romPath(VANILLA), 0x111)
    const cold = Date.now() - t0
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    expect([r.width, r.height]).toEqual([240 * 16, 27 * 16])
    expect(r.lines.some(l => l.kind === 'floor')).toBe(true)
    expect(cold).toBeLessThan(5000)
    const t1 = Date.now()
    expect(await mapCollision(cache, bytes, romPath(VANILLA), 0x111)).toBe(r) // the same reply object
    expect(Date.now() - t1).toBeLessThan(100)
  }, 120_000)

  it('new bytes are a new working copy: probed again, same lines for the same ROM', async () => {
    const a = rom()
    const cache = new L1ModelCache()
    const first = await mapCollision(cache, a, romPath(VANILLA), 0x111)
    const second = await mapCollision(cache, new Uint8Array(a), romPath(VANILLA), 0x111)
    expect(second).not.toBe(first)
    expect(second).toEqual(first)
  }, 120_000)

  it('a patched block routine changes what the working copy answers (here it breaks it: unavailable)', async () => {
    const patched = RomFile.fromBytes(romPath(VANILLA), rom())
    patched.writeAt(0x00eadb, [0x00]) // a BRK at the collision routine
    const r = await mapCollision(new L1ModelCache(), patched.buffer, romPath(VANILLA), 0x111)
    expect(r).toEqual({ status: 'unavailable', reason: expect.stringMatching(/BRK|calibration/) })
  }, 120_000)

  it('a stale request is abandoned and not kept: the next one is computed afresh', async () => {
    const bytes = rom()
    const cache = new L1ModelCache()
    const stale = await mapCollision(cache, bytes, romPath(VANILLA), 0x111, () => true)
    expect(stale).toEqual({ status: 'stale' })
    expect((await mapCollision(cache, bytes, romPath(VANILLA), 0x111)).status).toBe('ok')
  }, 120_000)
})
