/**
 * #786: a map the backend cannot build answers with a fixed plain `reason` and
 * the exception text apart in `detail`, so the view never shows raw text.
 * Synthetic bytes: a zero-filled buffer has no readable map mode, which makes
 * the real build throw. No ROM needed.
 */
import { describe, it, expect } from 'vitest'
import { SWITCH_FLAGS_UNCLEARED as UNCLEARED } from '../../../src/rom/ObjectExpander'
import { L1ModelCache, mapScreen } from '../../../theia/extension/src/node/map-screen'

describe('mapScreen on a map whose build throws (#786)', () => {
  it('keeps exception text out of the reason and in the detail', () => {
    const r = mapScreen(new L1ModelCache(), new Uint8Array(0x8000), 'x.sfc', 5, 0, UNCLEARED)
    if (r.status !== 'unavailable') throw new Error(`expected unavailable, got ${r.status}`)
    expect(r.reason).toBe('This part of the map could not be read from the ROM.')
    expect(r.reason).not.toContain('$')
    expect(r.detail).toMatch(/\$/)
    expect(r.detail).not.toBe(r.reason)
  })
})
