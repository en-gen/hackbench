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
import { SWITCH_FLAGS_UNCLEARED as UNCLEARED } from '../../../src/rom/ObjectExpander'
import { L1ModelCache, mapScreen } from '../../../theia/extension/src/node/map-screen'
import { bgModeRom, IRQ_AT } from '../support/bgModeRom'
import { hGrid, inputs } from '../support/mapInputs'

vi.mock('../../../src/rom/model/L1Model', async importOriginal => {
  const real = await importOriginal<typeof L1ModelMod>()
  return { ...real, buildL1Inputs: vi.fn(() => ({ ok: true as const, inputs: inputs(hGrid(1), false, 1) })) } // prettier-ignore
})

describe('the default L1ModelCache (synthetic)', () => {
  const orderNote = (bytes: Uint8Array) => {
    const r = mapScreen(new L1ModelCache(), bytes, 'x.sfc', 5, 0, UNCLEARED)
    if (r.status !== 'ok') throw new Error(r.status)
    return r.layerNotes.find(n => n.startsWith('Layer order unverified'))
  }

  it('says nothing for a ROM that sets mode 1 through an intact path', () => {
    expect(orderNote(bgModeRom(1).buffer)).toBeUndefined()
  })

  it('draws the map and notes the order as unverified for another mode, or a broken path', () => {
    expect(orderNote(bgModeRom(2).buffer)).toMatch(/BG mode 2/)
    expect(orderNote(bgModeRom(1, [IRQ_AT, [0, 0, 0, 0, 0]]).buffer)).toMatch(/could not be verified/) // prettier-ignore
  })
})
