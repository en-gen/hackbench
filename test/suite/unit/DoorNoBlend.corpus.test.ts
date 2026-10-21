/**
 * #936 precondition: on the vanilla ROM no door pixel lies under a layer in its map's CGADSUB, so the
 * no-blend rule would not change vanilla output, EXCEPT on maps $011, $130 and $1C1 (#563), where a
 * door under their translucent Layer 3 is blended by the rule (D60 B / D62 call 2 B: the tile part takes the
 * covering plane's CGADSUB bit, the sprite part skips color math). That exception is the owner's to
 * confirm: it is queued with Decisions and under owner review. This checks the data, not ColorMath (the code is covered by
 * DoorNoBlend.test.ts); the predicate is test/suite/support/doorBlend.ts, proven able to go red there.
 * Every map 0x000-0x1FF that builds, every screen with sprites and a color-math table, sprites cut the way
 * the map view cuts them, lists as the view composes them (withFlameKeys). The invariant is `hits` empty;
 * the counts are only coverage floors, because a legitimate sprite fix moves exact totals (#995). Vanilla
 * ROM, one machine.
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
import { blendedOnlyByLayer3, doorPixelsUnderMath } from '../support/doorBlend'

const NO_FLAGS: SwitchFlagsDto = { green: false, yellow: false, blue: false, red: false }

// Coverage floors, set below the vanilla measurement (488 maps, 1315 screens, one machine) so a sprite fix
// that moves a few screens stays green, while a sweep that silently covers little still goes red.
const MIN_MAPS = 400 // a broken map builder or sprite parser drops whole maps, not a few
const MIN_SCREENS = 1000 // a sweep that skips the sprite or color-math screens would otherwise pass with hits empty

// The one place on vanilla where the precondition is false by design (#563): CODE_009FB8 clears BG3 from
// CGADSUB on every Layer 3 path except $81-$BF off Castle1/Underground1 (bank_00.asm:4170-4199), i.e. maps
// $011, $130 and $1C1 (CGADSUB $24 in their captures, bit 2 = BG3). A sprite behind one of their Layer 3
// tiles is a door under a blended layer, and the view's rule is then the intended one (obj-priority.md,
// D60 B / D62 call 2 B, proven in DoorNoBlend.test.ts): the tile part takes the covering plane's CGADSUB
// bit, the sprite part skips color math. A door is an editor see-through; the game draws the tile there.
// Exempt only when every blended door pixel of the screen is covered by Layer 3 itself (the covering plane
// is the one whose bit is in CGADSUB); a door blended through Layer 1 or Layer 2, on any map, still fails.
const WORLD_LOCKED_L3_MAPS = ['11', '130', '1c1']
const isWorldLockedL3Hit = (hit: string, by: { l1: number; l2: number; l3: number }) =>
  WORLD_LOCKED_L3_MAPS.includes(hit.split('/')[0]!) && blendedOnlyByLayer3(by)

describe.skipIf(!hasRom(VANILLA))(
  'door and lift pixels never meet color math on vanilla (#936)',
  () => {
    it(
      'no door pixel lies under a layer whose bit is in the map CGADSUB, in all 8 layer show/hide combinations, across every map that builds',
      slow(120_000),
      () => {
        const bytes = new Uint8Array(freshRom().buffer)
        const cache = new L1ModelCache()
        let maps = 0
        let screens = 0
        // Door pixels per layer show/hide combination (bit 0 = Layer 1 shown, bit 1 = Layer 2, bit 2 = Layer 3).
        const doorPixels = [0, 0, 0, 0, 0, 0, 0, 0]
        const hits: string[] = []
        const exempt = new Set<string>()
        const noSprites: string[] = []
        for (let m = 0; m < 0x200; m++) {
          const built = cache.get(bytes, romPath(VANILLA), m, NO_FLAGS)
          if (!built.ok) continue
          maps++
          const sp = mapSprites(cache, bytes, romPath(VANILLA), m)
          if (sp.status !== 'ok') {
            noSprites.push(m.toString(16)) // built but unswept: must not hide behind the floors
            continue
          }
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
              const by = { l1: 0, l2: 0, l3: 0 }
              const found = doorPixelsUnderMath(lists, planes, doors, shot.math.cgadsub, by)
              doorPixels[c]! += found.doorPixels
              if (found.blended) {
                const hit = `${m.toString(16)}/${s}/${c}`
                hits.push(hit)
                if (isWorldLockedL3Hit(hit, by)) exempt.add(hit)
              }
            }
          }
        }
        console.log(`#936 vanilla: ${maps} maps, ${screens} screens with sprites, ${doorPixels.join('/')} door pixels per layer combination, ${hits.length} under a blended layer`) // prettier-ignore
        const unexplained = hits.filter(h => !exempt.has(h))
        expect(unexplained).toEqual([])
        expect(hits.length - unexplained.length, 'the Layer 3 exception is still in use').toBeGreaterThan(0) // prettier-ignore
        // A map that builds but has no sprite data is never scanned, so floors alone could pass over it.
        expect(noSprites).toEqual([])
        expect(maps).toBeGreaterThanOrEqual(MIN_MAPS)
        expect(screens).toBeGreaterThanOrEqual(MIN_SCREENS)
        // Combination 0 shows no layer, so it has no door pixels to meet; every other combination must see some,
        // or the predicate is being run on empty planes and "no hits" proves nothing.
        expect(doorPixels.slice(1).every(n => n > 0)).toBe(true)
      },
    )
  },
)
