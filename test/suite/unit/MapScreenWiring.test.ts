/**
 * The production wiring of the map tab's backend: `new L1ModelCache()`, as
 * theia/extension/src/node/project-server.ts builds it, must put the BG mode
 * check and the background reading on every map. Only L1's own build is
 * stubbed (a synthetic ROM has no level to read); everything the default
 * cache adds runs for real. A separate file so the mock cannot reach the
 * other map-screen suites.
 */
import { describe, it, expect, vi } from 'vitest'
import type * as L1ModelMod from '../../../src/rom/model/L1Model'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { SWITCH_FLAGS_UNCLEARED as UNCLEARED } from '../../../src/rom/ObjectExpander'
import { L1ModelCache, mapScreen } from '../../../theia/extension/src/node/map-screen'
import { bgModeRom, IRQ_AT } from '../support/bgModeRom'

vi.mock('../../../src/rom/model/L1Model', async importOriginal => {
  const real = await importOriginal<typeof L1ModelMod>()
  const inputs: L1ModelMod.L1Inputs = {
    header: parseLevelHeader([0, 0, 0, 0, 0]),
    isVertical: false,
    screenCount: 1,
    grid: Array.from({ length: 27 }, () => new Array<number>(16).fill(0)),
    map16: { tiles: [], pipeVariants: [] },
    rawVram: { fg1: [] },
    anim: null,
    vram: { fg1: [] },
    colors: [],
    backArea: [0, 0, 0, 255],
    unverified: [],
    switchArt: new Map(),
  }
  return { ...real, buildL1Inputs: vi.fn(() => ({ ok: true as const, inputs })) }
})

describe('the default L1ModelCache (synthetic)', () => {
  const orderNote = (bytes: Uint8Array) => {
    const r = mapScreen(new L1ModelCache(), bytes, 'x.sfc', 5, 0, UNCLEARED)
    if (r.status !== 'ok') throw new Error(r.status)
    return r.orderNote
  }

  it('says nothing for a ROM that sets mode 1 through an intact path', () => {
    expect(orderNote(bgModeRom(1).buffer)).toBeUndefined()
  })

  it('draws the map and notes the order as unverified for another mode, or a broken path', () => {
    expect(orderNote(bgModeRom(2).buffer)).toMatch(/BG mode 2/)
    expect(orderNote(bgModeRom(1, [IRQ_AT, [0, 0, 0, 0, 0]]).buffer)).toMatch(/could not be verified/) // prettier-ignore
  })
})
