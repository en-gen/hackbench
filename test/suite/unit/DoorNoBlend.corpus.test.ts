/**
 * #936: the no-blend rule for screen-door and lifted sprite pixels is a no-op on the vanilla ROM.
 * Every map 0x000-0x1FF, every screen, sprites cut the way the map view cuts them. A door pixel is a
 * sprite pixel under an opaque tile of a layer; it is counted when that layer's bit is in the map's
 * CGADSUB, the only case where the rule changes the output. Vanilla ROM, one machine.
 */
import { describe, it, expect } from 'vitest'
import { MAP_PLANE_KEYS } from '../../../theia/extension/src/common/project-protocol'
import { L1ModelCache, screenResult } from '../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { spriteDoors, spritePlanes } from '../../../theia/extension/src/browser/map-view-model'
import { VANILLA, freshRom, hasRom, romPath } from '../support/corpus'
import { slow } from '../support/loadTimeout'

const BIT = { l1: 0x01, l2: 0x02, l3: 0x04 } as const

describe.skipIf(!hasRom(VANILLA))(
  'door and lift pixels never meet color math on vanilla (#936)',
  () => {
    it(
      'no door pixel lies under a layer whose bit is in the map CGADSUB, across all 512 maps',
      slow(120_000),
      () => {
        const bytes = new Uint8Array(freshRom().buffer)
        const cache = new L1ModelCache()
        let maps = 0
        let screens = 0
        let doorPixels = 0
        const hits: string[] = []
        for (let m = 0; m < 0x200; m++) {
          const sp = mapSprites(cache, bytes, romPath(VANILLA), m)
          const built = cache.get(bytes, romPath(VANILLA), m, {
            blue: false,
            silver: false,
            onOff: false,
          } as never)
          if (sp.status !== 'ok' || !built.ok) continue
          maps++
          for (let s = 0; s < sp.screenCount; s++) {
            const doors = spriteDoors(sp, s)
            if (!doors) continue
            const shot = screenResult(built.inputs, s)
            if (shot.status !== 'ok' || !shot.math) continue
            screens++
            const planes = { ...spritePlanes(sp, s) } as Record<string, Uint8ClampedArray | null>
            for (const k of MAP_PLANE_KEYS) planes[k] = shot.planes[k] ? new Uint8ClampedArray(Buffer.from(shot.planes[k]!, 'base64')) : null // prettier-ignore
            for (let p = 0; p < doors.length; p++) {
              if (!doors[p]) continue
              // The topmost plane with any alpha at the pixel: a tile layer there covers the sprite below it.
              const top = [...shot.screens.main]
                .reverse()
                .find(k => (planes[k]?.[p * 4 + 3] ?? 0) > 0)
              if (!top || top.startsWith('sprites')) continue
              doorPixels++
              if (shot.math.cgadsub & BIT[top.slice(0, 2) as keyof typeof BIT])
                hits.push(`${m.toString(16)}/${s}`)
            }
          }
        }
        console.log(`#936 vanilla: ${maps} maps, ${screens} screens with sprites, ${doorPixels} door pixels, ${hits.length} under a blended layer`) // prettier-ignore
        expect(maps).toBeGreaterThan(400)
        expect(doorPixels).toBeGreaterThan(0)
        expect(hits).toEqual([])
      },
    )
  },
)
