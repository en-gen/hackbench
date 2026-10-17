/**
 * Sprite $E0 on the vanilla ROM (the $E0 issue). Gated on the ROM. Derived from the ROM's own code, no hardware
 * comparison: every placement spawns its three $A3 on the vanilla routines and draws through the map view, never a
 * marker. A sweep of maps 0-$1FF found $E0 only on maps $005 (8 placements) and $135 (7); the sweep is not re-run here
 * (55 s), the two maps are, and the headline numbers are in docs/sprites/sprite-e0-chain-platforms.md.
 */
import { describe, expect, it } from 'vitest'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { PLATFORM_COUNT, threePlatforms } from '../../../../src/rom/sprites/interp/ThreePlatforms'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { cameraFor, mapSprites } from '../../../../theia/extension/src/node/map-sprites'
import { freshRom, hasRom, romPath, VANILLA } from '../../support/corpus'

/** Map, placements, and (for $135) the pixel positions the issue lists. */
const MAPS: [number, number][] = [[0x005, 8], [0x135, 7]] // prettier-ignore
const MAP_135 = [[368, 240], [768, 192], [1712, 176], [2112, 320], [3056, 176], [3888, 160], [4496, 208]] // prettier-ignore

function placements(map: number) {
  const rom = freshRom()
  const data = rom.readUpTo(new SmwRom(rom).getLevelSpritePointer(map)!, 0x200)!
  return { rom, sprites: parseLevelSprites(data, false).filter(s => s.spriteId === 0xe0) }
}

describe.skipIf(!hasRom(VANILLA))('sprite $E0, vanilla ROM', () => {
  it.each(MAPS)('map %i: the list holds the expected number of $E0 placements', (map, n) => {
    expect(placements(map).sprites).toHaveLength(n)
  })

  it("map $135: the placements are at the issue's pixel positions", () => {
    const at = placements(0x135).sprites.map(s => [s.x * 16, s.y * 16])
    expect(at).toEqual(MAP_135)
  })

  it.each(MAPS)(
    'map %i: every placement spawns three platforms on the vanilla routines',
    (map, n) => {
      const { rom, sprites } = placements(map)
      const base = levelSeed(rom, map)
      const w = base.loaded!
      const mario = { x: w[0x94]! | (w[0x95]! << 8), y: w[0x96]! | (w[0x97]! << 8) }
      expect(sprites).toHaveLength(n)
      for (const e of sprites) {
        const [x, y] = [e.x * 16, e.y * 16]
        const seed = withSeed({ sprite: { x, y }, camera: cameraFor(x, y, false, 32), mario }, base) // prettier-ignore
        const res = threePlatforms(rom, seed, {
          x,
          y,
          index: e.index,
          streamOffset: e.streamOffset,
        })
        if (!res.ok) throw new Error(res.reason)
        expect(res.unverified, 'no routine differs from vanilla').toEqual([])
        expect(res.notes).toEqual([])
        expect(res.spawned).toBe(PLATFORM_COUNT)
        // Three platforms, each a platform piece plus its chain links: more than one piece per platform.
        expect(res.parts.length).toBeGreaterThan(PLATFORM_COUNT)
      }
    },
  )

  it('draws through the map view, never a marker, and $A3 placed directly still draws', () => {
    const bytes = new Uint8Array(freshRom().buffer)
    for (const [map, n] of MAPS) {
      const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), map)
      if (r.status !== 'ok') throw new Error(`map ${map.toString(16)}: ${r.status}`)
      const e0 = r.sprites.filter(s => s.id === 0xe0)
      expect(e0, `map ${map.toString(16)}`).toHaveLength(n)
      for (const s of e0) {
        expect(s.status, JSON.stringify({ ...s, rgba: undefined, priority: undefined })).toBe('drawn') // prettier-ignore
        expect(s.unverified).toBeUndefined()
        expect(s.note).toBeUndefined()
        // The group spans a chain's length either side: far bigger than the 16 x 16 placeholder.
        expect(s.box.x1 - s.box.x0).toBeGreaterThan(64)
      }
    }
    // The 24 $A3 placed directly (22 on $023, 2 on $135) are drawn as themselves, one 48 x 48 platform each.
    for (const [map, n] of [
      [0x023, 22],
      [0x135, 2],
    ] as const) {
      // prettier-ignore
      const r = mapSprites(new L1ModelCache(), bytes, romPath(VANILLA), map)
      if (r.status !== 'ok') throw new Error(`map ${map.toString(16)}: ${r.status}`)
      const a3 = r.sprites.filter(s => s.id === 0xa3)
      expect(a3, `map ${map.toString(16)}`).toHaveLength(n)
      for (const s of a3) {
        expect(s.status).toBe('drawn')
        expect([s.box.x1 - s.box.x0, s.box.y1 - s.box.y0]).toEqual([48, 48])
      }
    }
  })
})
