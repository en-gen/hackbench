/**
 * #786: a map whose build THROWS answers `mapScreen` with a fixed plain `reason` and
 * the exception text apart in `detail`, so the view never shows raw text. A build that
 * RETURNS a gate reason gets the same treatment: gate reasons can contain ROM-internal
 * terms, so they stay in `detail` too. The wording is made once, in the shared cache (#967),
 * so sprites, collision, block contents and the toolbar get it too.
 * Synthetic stubs: no ROM needed.
 */
import { describe, it, expect } from 'vitest'
import { SWITCH_FLAGS_UNCLEARED as UNCLEARED } from '../../../src/rom/ObjectExpander'
import { ADDR } from '../../../src/rom/SmwRom'
import { loromToOffset } from '../../../src/rom/addressing'
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

  it('words the shared cache entry once: plain reason, raw text in detail (#967)', () => {
    const cache = new L1ModelCache(() => {
      throw new Error('planted')
    })
    const built = cache.get(bytes, 'x.sfc', 5, UNCLEARED)
    expect(built).toEqual({ ok: false, reason: 'this part of the map could not be read from the ROM.', detail: 'planted' }) // prettier-ignore
  })

  it('does the same for a gate reason the build returns (#967)', () => {
    const cache = new L1ModelCache(() => ({ ok: false, reason: 'No VerticalTable here.' }))
    expect(cache.get(bytes, 'x.sfc', 5, UNCLEARED)).toEqual({ ok: false, reason: 'this part of the map could not be read from the ROM.', detail: 'No VerticalTable here.' }) // prettier-ignore
  })

  it('keeps a returned gate reason out of the visible reason, in detail only', () => {
    const cache = new L1ModelCache(() => ({ ok: false, reason: 'No VerticalTable here.' }))
    const r = mapScreen(cache, bytes, 'x.sfc', 5, 0, UNCLEARED)
    expect(r).toEqual({ status: 'unavailable', reason: PLAIN, detail: 'No VerticalTable here.' })
  })
})

describe('mapScreen on a map whose pointer is valid but whose data cannot be read (#949, D155)', () => {
  // The real build, no stub: $FFFFFC resolves to the last four bytes of the 4 MB image,
  // one short of a level header. The row warns; opening it must answer this, not a blank.
  const size = 0x400000
  const image = new Uint8Array(size)
  image[0x7fd5] = 0x20
  const table = loromToOffset(ADDR.LEVEL_L1_PTR, size)!
  for (const [slot, ptr] of [
    [5, 0xfffffc],
    [6, 0xfffffe],
    [7, 0x000000],
  ] as const) {
    image.set([ptr & 0xff, (ptr >> 8) & 0xff, ptr >> 16], table + slot * 3)
  }

  it.each([5, 6, 7])('answers the plain reason for slot %i, never an ok reply', slot => {
    const r = mapScreen(new L1ModelCache(), image, 'x.sfc', slot, 0, UNCLEARED)
    expect(r).toMatchObject({ status: 'unavailable', reason: PLAIN })
  })
})
