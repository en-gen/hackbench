/**
 * #1230: the map view's call site (`interpRunner` in map-sprites.ts) hands the rope to `ropeModel` with the right setting,
 * orientation and gate. Synthetic loader (the `ropeHooks` fingerprint) and a stand-in run that records the slot it was
 * given, so CI (no ROM) goes red on a call site that reads the wrong setting, ignores a vertical map, matches the wrong
 * ids or runs without a loader image.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import {
  SPRITE_SEED,
  withSeed,
  type SpriteSeed,
} from '../../../../src/rom/sprites/interp/SpriteSeed'
import type { SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import {
  interpRunner,
  modelResult,
  type RunModel,
} from '../../../../theia/extension/src/node/map-sprites'
import { drawer } from '../../support/ropeStandIn'
import { slotCart, SPECIAL } from '../../support/slotPickCart'

const { rom, spec } = slotCart()
const image = (setting: number, loadedAtStart = false): SpriteSeed => {
  const loaded = new Uint8Array(0x20000)
  loaded[0x1692] = setting
  // The map's own loader placed list entry 0: the call site then tries the screen-fixed probe run.
  loaded[0x1938] = loadedAtStart ? 1 : 0
  return withSeed({ loaded }, SPRITE_SEED)
}
const sprite = (id: number, x: number, y: number): LevelSprite => ({ screen: 0, x, y, spriteId: id, extraBit: false, raw: [0, 0, 0], index: 0, streamOffset: 0 }) // prettier-ignore

/** Runs one sprite through the real call site; `seen` is every slot the stand-in was run in. */
function run(
  id: number,
  x: number,
  y: number,
  o: {
    setting?: number
    vertical?: boolean
    snaps?: boolean
    noImage?: boolean
    probe?: boolean
  } = {},
) {
  const seen: number[] = []
  const passes: number[] = []
  const setting = o.setting ?? 1
  const stand = drawer(setting, seen, undefined, o.snaps ?? true)
  const go = interpRunner(rom, 0, { isVertical: !!o.vertical, screenCount: 2 }, (_r, _i, s) => (passes.push(s.mainPasses), stand(s.slot)), () => (o.noImage ? SPRITE_SEED : image(setting, o.probe)), undefined, undefined, undefined, [], { spec }) // prettier-ignore
  const r = go(sprite(id, x, y)) as { m: SpriteModel }
  return { seen, passes, m: r.m, tiles: r.m.passes[0]!.parts.length }
}

describe('the map view call site of the rope', () => {
  it('reads the map setting from the loader image: setting 1 odd 9, even 5; another setting walks its own table', () => {
    expect(run(SPECIAL, 1, 2).tiles).toBe(9)
    expect(run(SPECIAL, 2, 2).tiles).toBe(5)
    // Setting 2 shares its top slot with ordinary sprites: both slots run; the short rope is shown.
    expect(run(SPECIAL, 1, 2, { setting: 2 })).toMatchObject({ tiles: 5, seen: [6, 2] })
    expect(run(SPECIAL, 1, 2, { setting: 0 }).tiles).toBe(5)
  })
  it('takes the row parity on a vertical map: rows decide, columns do not', () => {
    expect(run(SPECIAL, 2, 5, { vertical: true }).tiles).toBe(9)
    expect(run(SPECIAL, 1, 4, { vertical: true }).tiles).toBe(5)
    expect(run(SPECIAL, 1, 4).tiles).toBe(9)
  })
  it('runs only the rope through the slot walk: other line-guided ids stay in slot 0', () => {
    for (const id of [0x62, 0x65, 0x66, 0x67, 0x68, 0x01])
      expect(run(id, 1, 2).seen, `id ${id}`).toEqual([0])
  })
  it('a draw the gate did not confirm is run in slot 0 with no note', () => {
    const r = run(SPECIAL, 1, 2, { snaps: false })
    expect(r.seen.at(-1)).toBe(0)
    expect(r.m.lengthNote).toBeUndefined()
  })
  it('without a loader image the rope stays short in slot 0 and says so', () => {
    const r = run(SPECIAL, 1, 2, { noImage: true })
    expect(r).toMatchObject({ seen: [0], tiles: 5 })
    expect(r.m.lengthNote).toMatch(/level loader could not be run/)
  })
  it('a rope the gate confirmed skips the screen-fixed probe run; one that lost the gate does not', () => {
    // The probe is the only run with a shortened pass count.
    const probes = (snaps: boolean) => run(SPECIAL, 1, 2, { snaps, probe: true }).passes.filter(p => p !== SPRITE_SEED.mainPasses).length // prettier-ignore
    expect(probes(true)).toBe(0)
    expect(probes(false)).toBeGreaterThan(0)
  })
  it('the no-image note goes only on a rope the gate confirmed', () => {
    expect(run(SPECIAL, 1, 2, { noImage: true, snaps: false }).m.lengthNote).toBeUndefined()
  })
  it('the panel note joins "never appears in play" with the length note, and either alone is unchanged', () => {
    const m = run(SPECIAL, 1, 2, { noImage: true }).m as RunModel
    const both = modelResult({ ...m, neverAppears: true } as RunModel)
    const only = modelResult({ ...m, lengthNote: undefined, neverAppears: true } as RunModel)
    const length = modelResult(m)
    expect(both).toMatchObject({ note: expect.stringMatching(/^never appears in play The rope is shown at its short length/) }) // prettier-ignore
    expect(only).toMatchObject({ note: 'never appears in play' })
    expect(length).toMatchObject({
      note: expect.stringMatching(/^The rope is shown at its short length/),
    })
  })
})
