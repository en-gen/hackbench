/**
 * #967: sprites, collision, block contents and the toolbar read-failures answer with plain
 * words in `reason` and the exception text only in `detail` (the #786 split). Synthetic: no ROM.
 */
import { describe, it, expect } from 'vitest'
import { mapBlockContents } from '../../../theia/extension/src/node/map-block-contents'
import { mapCollision, mapCollisionCheck } from '../../../theia/extension/src/node/map-collision'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { readFailed, withDetail } from '../../../theia/extension/src/browser/map-view-messages'
import { NEUTRAL } from '../../../src/rom/collision/TileProbe'
import { hGrid, inputs } from '../support/mapInputs'

const PLAIN = 'this map could not be read from the ROM.'
const broken = () => new L1ModelCache(() => ({ ok: false, reason: 'planted: read past $05:8000' }))
// The model builds, but the bytes are no ROM, so the next read throws.
const throwing = () => new L1ModelCache(() => ({ ok: true, inputs: inputs(hGrid(2), false, 2) }))
const tiny = new Uint8Array(4)
const bytes = new Uint8Array(0x80000)
bytes[0x7fd5] = 0x20
const expected = (detail: unknown) => ({ status: 'unavailable', reason: PLAIN, detail })

describe('a map whose model cannot be built (#967)', () => {
  it('sprites', () => expect(mapSprites(broken(), bytes, 'x.sfc', 5)).toEqual(expected('planted: read past $05:8000'))) // prettier-ignore
  it('block contents', () => expect(mapBlockContents(broken(), bytes, 'x.sfc', 5)).toEqual(expected('planted: read past $05:8000'))) // prettier-ignore
  it('collision check', () => expect(mapCollisionCheck(broken(), bytes, 'x.sfc', 5)).toEqual(expected('planted: read past $05:8000'))) // prettier-ignore
  it('collision', async () => expect(await mapCollision(broken(), bytes, 'x.sfc', 5, NEUTRAL)).toEqual(expected('planted: read past $05:8000'))) // prettier-ignore
})

describe('a read that throws after the model is built (#967)', () => {
  const detail = expect.stringMatching(/\S/)
  it('sprites', () => expect(mapSprites(throwing(), tiny, 'x.sfc', 5)).toEqual(expected(detail)))
  it('block contents', () => expect(mapBlockContents(throwing(), tiny, 'x.sfc', 5)).toEqual(expected(detail))) // prettier-ignore
  it('collision check', () => expect(mapCollisionCheck(throwing(), tiny, 'x.sfc', 5)).toEqual(expected(detail))) // prettier-ignore
  it('collision', async () => expect(await mapCollision(throwing(), tiny, 'x.sfc', 5, NEUTRAL)).toEqual(expected(detail))) // prettier-ignore
})

describe('the view-side wording (#967)', () => {
  it('a rejected call keeps its text in detail only', () => {
    const r = readFailed(new Error('planted rpc'))
    expect(r.reason).toBe('this map could not be read just now. Open the map again to try again.')
    expect(r.detail).toBe('planted rpc')
    expect(r.reason).not.toContain('planted')
  })
  it('a detail goes on its own tooltip line, after the plain words', () => {
    expect(withDetail('plain', 'raw')).toBe('plain\nraw')
    expect(withDetail('plain', undefined)).toBe('plain')
  })
})
