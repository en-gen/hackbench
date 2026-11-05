/**
 * #793 part B: the four $1E2 tiles once seen in each grinder box on map $01F are the castle flames
 * (sprite $E6), not the grinder's. The game draws them, as OAM 124-127 from the cluster loop that runs
 * after the twelve sprite slots (SMWDisX bank_01.asm:128-130, CODE_02FA16 bank_02.asm:16230-16279),
 * fixed to Layer 2; the map view draws them once per copy as their own `fixedTo: 'layer2'` sprites
 * (#894) and keeps cluster sprites out of every tested sprite's OAM (#809). Evidence for the game:
 * Mesen capture layers_v5/01f frame 24, vanilla USA ROM, one machine: OAM 124-127 at X $50 $90 $D0
 * $10, screen Y $30, tile $E4 with attribute bit 0 set (char $1E4; $1E2 or $1E4 by the flicker),
 * and no other tile in the capture is a flame char.
 *
 * Pins: on the vanilla maps $01F and $01A, every pass of every grinder is four consecutive OAM entries
 * with no flame char, and each drawn grinder's reply box is its 32 x 32 body only. The detector is proven
 * able to fail on a planted part (no ROM), as the corpus block alone would pass on an empty list.
 * The mechanism of #809 itself (clearing $18B8 and each cluster number cell) is guarded by
 * ClusterOamLeak.test.ts; a mutant that clears only one of the two survives this file.
 * The shape check is relative to the run's own entries, not a fixed OAM floor: the runner places the
 * tested sprite at OAM 76-79, where hardware puts grinder bodies at 121-124.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import {
  interpDrawer,
  mapSprites,
  readStream,
} from '../../../../theia/extension/src/node/map-sprites'
import { hasRom, romPath, VANILLA } from '../../support/corpus'

/** The flame chars: tiles $E2/$E4 with attribute bit 0 set. */
const FLAME_CHARS = new Set([0x1e2, 0x1e4])

interface Part {
  oam: number
  char: number
}
/** What a pass holds besides a grinder's body: flame chars as `oam:char`, and 'shape' unless the parts are 4 consecutive entries (or none). */
function strays(parts: readonly Part[]): string[] {
  const out = parts.filter(p => FLAME_CHARS.has(p.char)).map(p => `${p.oam}:${p.char.toString(16)}`)
  const oams = parts.map(p => p.oam).sort((a, b) => a - b)
  const body = oams.length === 4 && oams.every((o, i) => o === oams[0]! + i)
  if (oams.length > 0 && !body) out.push('shape')
  return out
}

/** The vanilla ROM's path and bytes, as the map-view entry points take them. */
function vanilla() {
  const path = romPath(VANILLA)
  return { path, bytes: new Uint8Array(readFileSync(path)) }
}

describe('the stray-part detector', () => {
  it('passes a plain body, and goes red on a flame char or an OAM entry in the flame block', () => {
    const body = [76, 77, 78, 79].map(oam => ({ oam, char: 0x16e }))
    expect(strays(body)).toEqual([])
    expect(strays([...body, { oam: 124, char: 0x1e2 }])).toEqual(['124:1e2', 'shape'])
    expect(strays([...body, { oam: 90, char: 0x1e4 }])).toEqual(['90:1e4', 'shape'])
    expect(strays([...body, { oam: 127, char: 0x16e }])).toEqual(['shape'])
    expect(strays([{ oam: 76, char: 0x1e2 }, ...body.slice(1)])).toEqual(['76:1e2'])
    expect(strays([])).toEqual([])
  })
})

describe.skipIf(!hasRom(VANILLA))('vanilla grinders carry no castle flames (#793 B)', () => {
  for (const slot of [0x1f, 0x1a]) {
    it(`map $${slot.toString(16)}: every pass of every $67 is its four body pieces only`, () => {
      const { path, bytes } = vanilla()
      const rom = new SmwRom(RomFile.fromBytes(path, Buffer.from(bytes)))
      const built = new L1ModelCache().get(bytes, path, slot, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const data = readStream(rom.rom, rom.getLevelSpritePointer(slot)!)
      const grinders = parseLevelSprites(data, built.inputs.isVertical).filter(x => x.spriteId === 0x67) // prettier-ignore
      expect(grinders).toHaveLength(slot === 0x1f ? 7 : 13)
      let drewPasses = 0
      const draw = interpDrawer(rom.rom, slot, built.inputs, (r, id, sd) => {
        const m = runOnce(r, id, sd)
        m.passes.forEach((p, pi) => {
          expect(strays(p.parts), `pass ${pi}`).toEqual([])
          if (p.parts.length > 0) drewPasses++
        })
        return m
      })
      grinders.forEach(g => draw(g))
      // A run that drew nothing would pass the loop above.
      expect(drewPasses).toBeGreaterThan(0)
    }, 300_000)
  }

  // Floors, not totals: #993 draws the 3 erased $1A grinders (10 drawn today, 13 after it).
  it.each([
    ['1f', 7, 7],
    ['1a', 10, 13],
  ])(
    'map $%s: at least %i-%i drawn grinders, each box 32 x 32',
    (slotHex, min, max) => {
      const slot = parseInt(slotHex, 16)
      const { path, bytes } = vanilla()
      const r = mapSprites(new L1ModelCache(), bytes, path, slot)
      if (r.status !== 'ok') throw new Error(r.status)
      const drawn = r.sprites.filter(d => d.id === 0x67 && d.status === 'drawn')
      expect(drawn.length).toBeGreaterThanOrEqual(min)
      expect(drawn.length).toBeLessThanOrEqual(max)
      for (const d of drawn) expect([d.box.x1 - d.box.x0, d.box.y1 - d.box.y0], `(${d.x},${d.y})`).toEqual([32, 32]) // prettier-ignore
    },
    300_000,
  )

  it('map $1f: the flames are their own layer-2 sprites, 4 per copy', () => {
    const { path, bytes } = vanilla()
    const r = mapSprites(new L1ModelCache(), bytes, path, 0x1f)
    if (r.status !== 'ok') throw new Error(r.status)
    const flames = r.sprites.filter(d => d.fixedTo === 'layer2')
    expect(flames.length).toBeGreaterThan(0)
    expect(flames.length % 4).toBe(0)
    expect(new Set(flames.map(d => d.id))).toEqual(new Set([0xe6]))
  }, 300_000)
})
