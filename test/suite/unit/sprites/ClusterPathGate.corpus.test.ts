/**
 * #1061: the call-path gate (CastleFlames.ts pathMismatches) on the six corpus ROMs. Develop's byte checks flagged
 * "the cluster loop" on the three hacks that hook the loop with foreign code (one machine, 2026-11-03); a
 * run that merely reaches the draw let all three pass, so the gate now flags every fetch outside the expected
 * path. The synthetic equivalent, with no ROM, is the "a hook in the loop" row of PATH_HACKS.
 * Evidence scope: the six ROMs of corpus.cjs, one read each.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { FLAME_PATH, pathMismatches } from '../../../../src/rom/sprites/interp/CastleFlames'
import { ringGate } from '../../../../src/rom/sprites/interp/RotatingRing'
import { CORPUS, hasRom, romPath } from '../../support/corpus'

const names = (xs: string[]) => xs.map(x => x.replace(/ \(.*\)$/, ''))
const HOOKED = ['Grand Poo World 2 1.1.sfc', 'GrandPooWorld_V1.2.sfc', 'Invictus 1.0.sfc']

describe.each(CORPUS)('%s', name => {
  const hooked = HOOKED.includes(name)
  it.skipIf(!hasRom(name))(
    hooked
      ? 'flags the loop, with the foreign address, for the flames and the ring'
      : 'passes the path',
    () => {
      const rom = RomFile.load(romPath(name))
      const flames = pathMismatches(rom, FLAME_PATH)
      const ring = ringGate(rom).filter(x => !/ring (spawn|draw|contact)|helpers/.test(x))
      if (hooked) {
        expect(names(flames)).toEqual(['the cluster loop'])
        expect(names(ring)).toEqual(['the cluster loop'])
        expect(flames[0]).toMatch(/runs code at \$[0-9A-F]{6}/)
      } else if (name === 'Seven_Vanilla_Levels.sfc') {
        // Its ring spawn is hooked (develop flagged 'the ring spawn routine'); the run now also names the foreign fetch.
        expect(flames).toEqual([])
        expect(names(ring)).toEqual(['the loader route to the sprite spawn'])
        expect(ring[0]).toMatch(/runs code at \$[0-9A-F]{6}/)
      } else {
        expect(flames).toEqual([])
        expect(ring).toEqual([])
      }
    },
  )
})
