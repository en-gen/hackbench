/**
 * #786: a map whose build THROWS answers `mapScreen` with a fixed plain `reason` and
 * the exception text apart in `detail`, so the view never shows raw text. A build that
 * RETURNS a gate reason gets the same treatment: gate reasons can contain ROM-internal
 * terms, so they stay in `detail` too. The shared cache keeps the exception text as its
 * reason (sprites, collision and the toolbar read it).
 * Synthetic stubs: no ROM needed.
 */
import { describe, it, expect } from 'vitest'
import { SWITCH_FLAGS_UNCLEARED as UNCLEARED } from '../../../src/rom/ObjectExpander'
import { L1ModelCache, mapScreen } from '../../../theia/extension/src/node/map-screen'

const PLAIN = 'This part of the map could not be read from the ROM.'
// A LoROM header, so the cache's own ROM wrapper builds and the stubbed build is what runs.
const bytes = new Uint8Array(0x40000)
bytes[0x7fd5] = 0x20

describe('mapScreen on a map whose build throws (#786)', () => {
  it.each([0, 5, 0x105, 0x1ff])('splits reason and detail exactly for map $%i', index => {
    const cache = new L1ModelCache(() => {
      throw new Error('planted')
    })
    for (const screen of [0, 1, 7]) {
      // The second call per map is a cache hit and must answer the same.
      for (let call = 0; call < 2; call++) {
        const r = mapScreen(cache, bytes, 'x.sfc', index, screen, UNCLEARED)
        expect(r).toEqual({ status: 'unavailable', reason: PLAIN, detail: 'planted' })
      }
    }
  })

  it('leaves the shared cache entry as the exception text, for the other consumers', () => {
    const cache = new L1ModelCache(() => {
      throw new Error('planted')
    })
    const built = cache.get(bytes, 'x.sfc', 5, UNCLEARED)
    expect(built).toMatchObject({ ok: false, reason: 'planted' })
  })

  it('keeps a returned gate reason out of the visible reason, in detail only', () => {
    const cache = new L1ModelCache(() => ({ ok: false, reason: 'No VerticalTable here.' }))
    const r = mapScreen(cache, bytes, 'x.sfc', 5, 0, UNCLEARED)
    expect(r).toEqual({ status: 'unavailable', reason: PLAIN, detail: 'No VerticalTable here.' })
  })
})
