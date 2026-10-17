/**
 * #936 precondition: on the vanilla ROM no door pixel lies under a layer in its map's CGADSUB, so the
 * no-blend rule cannot change vanilla output. This checks the data, not ColorMath (the code is covered by
 * DoorNoBlend.test.ts); the predicate is test/suite/support/doorBlend.ts, proven able to go red there.
 * Every map 0x000-0x1FF, the 488 that build, 1317 screens with sprites and a color-math table, sprites cut
 * the way the map view cuts them, lists as the view composes them (withFlameKeys). Exact counts, so a
 * change in what is scanned fails loudly. Vanilla ROM, one machine.
 */
import { describe, it, expect } from 'vitest'
import {
  MAP_PLANE_KEYS,
  type SwitchFlagsDto,
} from '../../../theia/extension/src/common/project-protocol'
import { L1ModelCache, screenResult } from '../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import {
  spriteDoors,
  flamePlanes,
  spritePlanes,
  withFlameKeys,
} from '../../../theia/extension/src/browser/map-view-model'
import { VANILLA, freshRom, hasRom, romPath } from '../support/corpus'
import { slow } from '../support/loadTimeout'
import { doorPixelsUnderMath } from '../support/doorBlend'

const NO_FLAGS: SwitchFlagsDto = { green: false, yellow: false, blue: false, red: false }

// Measured on the vanilla ROM, one machine: 488 of 512 map slots build, 1317 of their screens have sprites and a color-math table.
// Was 1315 before #983: maps $107 and $1FB (the same level, two slots) screen 2 gained a sprite because the rotating ring ($E2 at x 2560, $E3 at x 496 on both) now draws as a real sprite, so its pixels reach that screen. Door pixels are unchanged. PR #987 (#792) re-pins this constant to 1314; whichever merges second must re-measure.
// Door pixels per layer show/hide combination (bit 0 = Layer 1 shown, bit 1 = Layer 2, bit 2 = Layer 3), from the second #936 review.
const DOOR_PIXELS = [0, 65180, 804, 65200, 8319, 73368, 9123, 73388]

describe.skipIf(!hasRom(VANILLA))(
  'door and lift pixels never meet color math on vanilla (#936)',
  () => {
    it(
      'no door pixel lies under a layer whose bit is in the map CGADSUB, in all 8 layer show/hide combinations, across the 488 maps that build',
      slow(120_000),
      () => {
        const bytes = new Uint8Array(freshRom().buffer)
        const cache = new L1ModelCache()
        let maps = 0
        let screens = 0
        const doorPixels = DOOR_PIXELS.map(() => 0)
        const hits: string[] = []
        for (let m = 0; m < 0x200; m++) {
          const sp = mapSprites(cache, bytes, romPath(VANILLA), m)
          if (sp.status !== 'ok') continue
          const built = cache.get(bytes, romPath(VANILLA), m, NO_FLAGS)
          if (!built.ok) continue
          maps++
          for (let s = 0; s < sp.screenCount; s++) {
            const doors = spriteDoors(sp, s)
            if (!doors) continue
            const shot = screenResult(built.inputs, s)
            if (shot.status !== 'ok' || !shot.math) continue
            screens++
            const decoded: Record<string, Uint8ClampedArray | null> = {}
            for (const k of MAP_PLANE_KEYS) decoded[k] = shot.planes[k] ? new Uint8ClampedArray(Buffer.from(shot.planes[k]!, 'base64')) : null // prettier-ignore
            const lists = withFlameKeys(shot.screens).main
            for (let c = 0; c < 8; c++) {
              // The planes the view composes (shownPlanes): a hidden layer is left out, sprites and flames added.
              const planes: Record<string, Uint8ClampedArray | null> = {}
              for (const k of MAP_PLANE_KEYS) if (c & (1 << (+k[1]! - 1))) planes[k] = decoded[k]!
              Object.assign(planes, spritePlanes(sp, s), flamePlanes(sp, s, decoded.l2High))
              const found = doorPixelsUnderMath(lists, planes, doors, shot.math.cgadsub)
              doorPixels[c]! += found.doorPixels
              if (found.blended) hits.push(`${m.toString(16)}/${s}/${c}`)
            }
          }
        }
        console.log(`#936 vanilla: ${maps} maps, ${screens} screens with sprites, ${doorPixels.join('/')} door pixels per layer combination, ${hits.length} under a blended layer`) // prettier-ignore
        expect([maps, screens, doorPixels]).toEqual([488, 1317, DOOR_PIXELS])
        expect(hits).toEqual([])
      },
    )
  },
)
