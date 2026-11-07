/**
 * Art past a map's edge grows no canvas on the short sides (#1325), on the vanilla maps where the
 * sprite census found it (develop dfb9d43a, one machine): $00E $01B $0F8 $110 past the bottom, $0D7 past
 * the top, nine maps past the left. Each map is its own `it`, from the literal lists below. Needs the
 * vanilla ROM; the synthetic cases are in OffMapExtent.test.ts.
 */
import { describe, it, expect } from 'vitest'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { contentRects, offMapPad } from '../../../theia/extension/src/browser/off-map-extent'
import { VANILLA, freshRom, hasRom, romPath } from '../support/corpus'
import { slow } from '../support/loadTimeout'

type Side = 'left' | 'top' | 'bottom'

/** Where the sprites' art reaches, then the pad the view gives the map on that side: `reach` > 0, `pad` 0. */
function check(map: number, side: Side): { reach: number; pad: number } {
  const bytes = new Uint8Array(freshRom().buffer)
  const sp = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), map)
  if (sp.status !== 'ok') throw new Error(`map $${map.toString(16)}: sprites ${sp.status}`)
  const vertical = sp.orientation === 'vertical'
  const [w, h] = vertical
    ? [sp.width, sp.height * sp.screenCount]
    : [sp.width * sp.screenCount, sp.height]
  const reach = Math.max(
    ...sp.sprites.map(s =>
      side === 'left' ? -s.box.x0 : side === 'top' ? -s.box.y0 : s.box.y1 - h,
    ),
  )
  const pad = offMapPad(w, h, contentRects([], sp.sprites), vertical, sp.screenCount)
  const bare = offMapPad(w, h, [], vertical, sp.screenCount)
  return { reach, pad: pad[side] - bare[side] }
}

const MAPS: [Side, number[]][] = [
  ['bottom', [0x00e, 0x01b, 0x0f8, 0x110]],
  ['top', [0x0d7]],
  ['left', [0x0c4, 0x0dd, 0x0eb, 0x0f0, 0x0fb, 0x1da, 0x1e6, 0x1e7, 0x1f9]],
]

describe.skipIf(!hasRom(VANILLA))(
  'art past a vanilla map edge adds no pad on that side (#1325)',
  () => {
    for (const [side, maps] of MAPS)
      for (const map of maps)
        it(
          `$${map.toString(16).toUpperCase().padStart(3, '0')}: art reaches past the ${side}, the ${side} pad stays 0`,
          slow(60_000),
          () => {
            const r = check(map, side)
            // The oracle can fail: the art does reach the edge, so a pad built from boxes would not be 0.
            expect(r.reach).toBeGreaterThan(0)
            expect(r.pad).toBe(0)
          },
        )
  },
)
