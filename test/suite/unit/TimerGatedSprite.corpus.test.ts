/**
 * The climbing net door ($54) on the vanilla ROM (#1002): the game draws nothing for it at rest (SMWDisX bank_01.asm:8056-8057
 * returns before the 9-tile flip unless a punch-armed timer runs), so the map view shows the quiet marker at each placed spot
 * and nothing else, and none of its pixels lands on the castle flames of $101. ROM-gated; the synthetic case is in
 * TimerGatedSprite.test.ts. Placements measured 2026-11-13 on the vanilla ROM.
 */
import { readFileSync } from 'fs'
import { describe, it, expect } from 'vitest'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { opaque, sharedPixels } from '../support/spritePixels'
import { slow } from '../support/loadTimeout'

const NET_DOOR = 0x54
const FLAME = 0xe6
/** Where the vanilla ROM places $54: map, then (x, y) in pixels. */
const PLACED: Record<number, [number, number][]> = {
  0x101: [[1280, 272], [1536, 304], [1696, 304]], // prettier-ignore
  0x1d3: [[176, 272], [352, 272], [512, 272]], // prettier-ignore
}

describe.skipIf(!hasRom(VANILLA))('climbing net door on the vanilla ROM', () => {
  const bytes = new Uint8Array(hasRom(VANILLA) ? readFileSync(romPath(VANILLA)) : 0)
  const get = (map: number) => {
    const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), map)
    if (r.status !== 'ok') throw new Error(JSON.stringify(r))
    return r.sprites
  }

  it.each([0x101, 0x1d3])(
    'map $%x: the doors are exactly the placed ones, each the quiet marker at its spot',
    slow(60_000),
    map => {
      const doors = get(map).filter(s => s.id === NET_DOOR)
      expect(doors.map(d => [d.x, d.y])).toEqual(PLACED[map])
      for (const d of doors) {
        expect(d).toMatchObject({
          status: 'quiet',
          reason: 'unrevealed',
          name: 'Climbing Net Door',
        })
        expect(d.box).toEqual({ x0: d.x, y0: d.y, x1: d.x + 16, y1: d.y + 16 })
      }
    },
  )

  it(
    'all six draw nothing but the one ring: the same pixels, interior clear',
    slow(120_000),
    () => {
      const doors = [0x101, 0x1d3].flatMap(m => get(m).filter(s => s.id === NET_DOOR))
      expect(doors.length).toBe(6)
      expect(new Set(doors.map(d => d.rgba)).size).toBe(1)
      const px = Array.from(opaque({ ...doors[0]!, box: { x0: 0, y0: 0, x1: 16, y1: 16 } }))
      // The ring and dot only: the interior between them and the corners stay clear.
      expect(px).toContain('7,1')
      expect(px).toContain('7,7')
      for (const clear of ['0,0', '15,15', '4,4', '11,4', '4,11']) expect(px).not.toContain(clear)
      expect(px.length).toBeLessThan(120) // a filled 16 x 16 box is 256
    },
  )

  it('no pixel of a door on $101 is a pixel of a castle flame', slow(60_000), () => {
    const sprites = get(0x101)
    const flames = sprites.filter(s => s.id === FLAME)
    expect(flames.length).toBe(34) // 32 drawn and 2 boxed on this ROM, one machine, 2026-11-13
    expect(flames.some(f => opaque(f).size > 0)).toBe(true)
    for (const d of sprites.filter(s => s.id === NET_DOOR))
      for (const f of flames)
        expect(sharedPixels(d, f), `door ${d.x},${d.y} flame ${f.x},${f.y}`).toEqual([])
  })
})
