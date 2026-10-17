/**
 * #967: sprites, collision, block contents and the toolbar read-failures answer with plain
 * words in `reason` and the exception text only in `detail` (the #786 split). Synthetic: no ROM.
 */
import { afterEach, describe, it, expect, vi } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  blockIndicators,
  mapBlockContents,
} from '../../../theia/extension/src/node/map-block-contents'
import { mapCollision, mapCollisionCheck } from '../../../theia/extension/src/node/map-collision'
import {
  L1ModelCache,
  palaceIconsOf,
  startUnavailable,
  toolbarArtOf,
} from '../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import {
  lowerFirst,
  unverifiedLabel,
  readFailed,
  romMissingMessage,
  withDetail,
} from '../../../theia/extension/src/browser/map-view-messages'
import { NEUTRAL } from '../../../src/rom/collision/TileProbe'
import { hGrid, inputs } from '../support/mapInputs'

const PLAIN = 'this map could not be read from the ROM.'
const COLLISION = 'collision cannot be worked out for this map on this ROM.'
const broken = () => new L1ModelCache(() => ({ ok: false, reason: 'planted: read past $05:8000' }))
// A model that builds (the real cache returns ok:false for bytes that are no ROM), so each
// function gets past `cache.get` and a failure after it lands in its own catch.
const built = () => ({ get: () => ({ ok: true, inputs: inputs(hGrid(2), false, 2) }) }) as unknown as L1ModelCache // prettier-ignore
const fresh = () => new Uint8Array(0x80000)
const loRom = () => {
  const b = fresh()
  b[0x7fd5] = 0x20
  return b
}
const bytes = loRom()
const expected = (detail: unknown, reason = PLAIN) => ({ status: 'unavailable', reason, detail })

describe('a map whose model cannot be built (#967)', () => {
  it('sprites', () => expect(mapSprites(broken(), bytes, 'x.sfc', 5)).toEqual(expected('planted: read past $05:8000'))) // prettier-ignore
  it('block contents', () => expect(mapBlockContents(broken(), bytes, 'x.sfc', 5)).toEqual(expected('planted: read past $05:8000'))) // prettier-ignore
  it('collision check', () => expect(mapCollisionCheck(broken(), bytes, 'x.sfc', 5)).toEqual(expected('planted: read past $05:8000'))) // prettier-ignore
  it('collision', async () => expect(await mapCollision(broken(), bytes, 'x.sfc', 5, NEUTRAL)).toEqual(expected('planted: read past $05:8000'))) // prettier-ignore
})

describe('a read that throws after the model is built (#967)', () => {
  // The seam: the model is built, then the ROM read inside each try throws.
  afterEach(() => vi.restoreAllMocks())
  const seam = () => vi.spyOn(RomFile, 'fromBytes').mockImplementation(() => { throw new Error('planted throw') }) // prettier-ignore
  it('sprites', () => {
    seam()
    expect(mapSprites(built(), fresh(), 'x.sfc', 5)).toEqual(expected('planted throw'))
  })
  it('block contents', () => {
    seam()
    expect(mapBlockContents(built(), fresh(), 'x.sfc', 5)).toEqual(expected('planted throw'))
  })
  it('collision check', () => {
    seam()
    expect(mapCollisionCheck(built(), fresh(), 'x.sfc', 5)).toEqual(expected('planted throw', COLLISION)) // prettier-ignore
  })
  it('collision', async () => {
    seam()
    expect(await mapCollision(built(), fresh(), 'x.sfc', 5, NEUTRAL)).toEqual(expected('planted throw', COLLISION)) // prettier-ignore
  })
  it('a collision check the level loader refuses keeps the gate text in detail', () => {
    // Zeroed LoROM bytes carry no level loader: the gate refuses rather than throws.
    expect(mapCollisionCheck(built(), loRom(), 'x.sfc', 5)).toEqual(expected(expect.stringMatching(/\S/), COLLISION)) // prettier-ignore
  })
  it('a collision probe that fails keeps its text in detail', async () => {
    const layer = async () => ({ ok: false as const, reason: 'planted probe' })
    expect(await mapCollision(built(), fresh(), 'x.sfc', 5, NEUTRAL, () => false, layer)).toEqual(expected('planted probe', COLLISION)) // prettier-ignore
  })
})

describe('refusals that are not a failed model build (#967)', () => {
  it('a sprite stream that cannot be found reads plainly, the pointer text in detail', () => {
    const r = mapSprites(built(), loRom(), 'x.sfc', 5)
    expect(r).toEqual({ status: 'unavailable', reason: "this map's sprites could not be found in the ROM.", detail: expect.stringMatching(/No sprite data at the pointer/) }) // prettier-ignore
  })
  it('block contents tables the ROM lacks read plainly, the reader text in detail', () => {
    const model = inputs(hGrid(2), false, 2)
    const r = blockIndicators(
      model,
      { kind: 'unavailable', unavailable: 'DATA_00F0A4: planted' },
      {} as never,
    )
    expect(r).toEqual({ status: 'unavailable', reason: "this ROM's block contents could not be read.", detail: 'DATA_00F0A4: planted' }) // prettier-ignore
  })
})

describe('toolbar art that cannot be drawn (#967)', () => {
  const px16 = new Uint8ClampedArray(1024).fill(9)
  const art = { yellow: { uncleared: px16, cleared: px16 }, green: { reason: 'planted palace' }, red: { reason: 'r' }, blue: { reason: 'b' } } // prettier-ignore
  const rom = () => new RomFile('e.sfc', Buffer.alloc(0x80000, 0))
  const SWITCH = "this switch's picture could not be drawn on this ROM."
  it('a map that cannot be built: plain text for each switch, the gate text in switchDetail', () => {
    const r = toolbarArtOf(rom(), { ok: false, reason: 'planted' }, art)
    if (r.status !== 'ok') throw new Error(r.status)
    const all = (v: string) => ({ blue: v, silver: v, onOff: v })
    expect(r.switchUnavailable).toEqual(all(PLAIN))
    expect(r.switchDetail).toEqual(all('planted'))
  })
  it('a ROM with no switch art: plain text, the per-ROM reasons in switchDetail', () => {
    const r = toolbarArtOf(rom(), { ok: true, inputs: { ...inputs(hGrid(1), false, 1), anim: null } }, art) // prettier-ignore
    if (r.status !== 'ok') throw new Error(r.status)
    expect(r.switchUnavailable).toEqual({ blue: SWITCH, silver: SWITCH, onOff: SWITCH })
    expect(r.switchDetail?.onOff).toMatch(/ON\/OFF/)
    expect(r.switchDetail?.blue).toMatch(/\S/)
    expect(JSON.stringify(r.switchUnavailable)).not.toMatch(/\$/)
  })
  it('a palace block that cannot be drawn: plain text, the reason in detail', () => {
    expect(palaceIconsOf(art)[1]).toEqual({ palace: 'green', unavailable: 'this block could not be drawn on this ROM.', detail: 'planted palace' }) // prettier-ignore
  })
})

describe('the start position (#967)', () => {
  it('a refusal reads plainly, the loader text in detail', () => {
    expect(startUnavailable('planted: no entrance at $05:8000')).toEqual({ status: 'unavailable', reason: 'the start position could not be worked out for this map.', detail: 'planted: no entrance at $05:8000' }) // prettier-ignore
  })
})

describe('the view-side wording (#967)', () => {
  it('an unverified sprite toggle names no code, the raw text is for the tooltip', () => {
    expect(unverifiedLabel()).toBe('Sprites · unverified: this ROM changes code the sprites depend on.') // prettier-ignore
  })
  it('a rejected call keeps its text in detail only', () => {
    const log = vi.spyOn(console, 'error').mockImplementation(() => {})
    const r = readFailed('Map 105 sprites')(new Error('planted rpc'))
    expect(log).toHaveBeenCalledWith('Map 105 sprites failed:', expect.any(Error))
    log.mockRestore()
    expect(r.reason).toBe('this map could not be read just now. Open the map again to try again.')
    expect(r.detail).toBe('planted rpc')
    expect(r.reason).not.toContain('planted')
  })
  it('a detail goes on its own tooltip line, after the plain words', () => {
    expect(withDetail('plain', 'raw')).toBe('plain\nraw')
    expect(withDetail('plain', undefined)).toBe('plain')
  })
  it('a missing-ROM sentence inside a prefixed tooltip starts in lower case', () => {
    expect(lowerFirst(romMissingMessage('X'))).toMatch(
      /^the base ROM X is not on this machine\. Choose File/,
    )
    expect(lowerFirst('')).toBe('')
  })
})
