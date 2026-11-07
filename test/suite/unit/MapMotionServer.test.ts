/**
 * mapMotion (the node side of Play): the reply for a vanilla map. Skipped without the ROM; the verdicts
 * and refusals themselves are proven on synthetic carts in MapMotion.test.ts.
 */
import { describe, expect, it } from 'vitest'
import { mapMotion } from '../../../theia/extension/src/node/map-motion'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { freshRom, hasRom, romPath, VANILLA } from '../support/corpus'

describe.skipIf(!hasRom(VANILLA))('mapMotion on the vanilla ROM', () => {
  const bytes = () => new Uint8Array(freshRom(VANILLA).buffer)
  const run = (index: number) => mapMotion(new L1ModelCache(), bytes(), romPath(VANILLA), index)

  it('$009 moves the camera, draws offsets from frame 0, and carries a strip per screen', () => {
    const r = run(0x009)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    expect(r.kind).toBe('own-motion')
    expect(r.cameraMoved).toBe(true)
    expect(r.shiftY[0]).toBe(0)
    expect(r.shiftY).toHaveLength(r.l2y.length)
    // The offset is the change in (camera minus Layer 2) from the load frame, at sampled frames.
    for (const f of [0, 1, 400, 2000, r.l2y.length - 1])
      expect(r.shiftY[f]).toBe(r.l1y[f]! - r.l2y[f]! - (r.l1y[0]! - r.l2y[0]!))
    // Relative X never changes, and the offset fits the 512 px period.
    expect(r.l1x.every((x, i) => x === r.l2x[i])).toBe(true)
    expect(r.shiftY.every(v => Math.abs(v) < 512)).toBe(true)
    expect(r.stripRows).toBe(80)
    expect(r.strips.length).toBeGreaterThan(1)
  })

  it('$1EF is shown as if Mario stands on Layer 2, with no camera movement', () => {
    const r = run(0x1ef)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    expect(r.kind).toBe('needs-mario')
    expect(r.note).toMatch(/Mario/)
    expect(r.cameraMoved).toBe(false)
    expect(r.l1x.every((x, i) => x === r.l2x[i])).toBe(true)
  })

  it('a map with no routine has none', () => {
    expect(run(0x105)).toEqual({ status: 'none' })
  })
})
