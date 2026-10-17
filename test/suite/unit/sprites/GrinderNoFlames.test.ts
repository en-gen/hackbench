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
 * Pins: no grinder on the vanilla map $01F or $01A carries a flame char or an OAM entry from 123 up in
 * any pass, and each drawn grinder's reply box is its 32 x 32 body only. The leak detector is proven
 * able to fail on a planted part (no ROM), as the corpus block alone would pass on an empty list.
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

/** The flame chars (tiles $E2/$E4 with attribute bit 0 set) and the first OAM entry of the flame block. */
const FLAME_CHARS = new Set([0x1e2, 0x1e4])
const FIRST_FLAME_OAM = 123

interface Part {
  oam: number
  char: number
}
/** The parts that do not belong to a grinder's body, as `oam:char` strings. */
const strays = (parts: readonly Part[]): string[] =>
  parts
    .filter(p => FLAME_CHARS.has(p.char) || p.oam >= FIRST_FLAME_OAM)
    .map(p => `${p.oam}:${p.char.toString(16)}`)

describe('the stray-part detector', () => {
  it('passes a plain body, and goes red on a flame char or an OAM entry in the flame block', () => {
    const body = [76, 77, 78, 79].map(oam => ({ oam, char: 0x16e }))
    expect(strays(body)).toEqual([])
    expect(strays([...body, { oam: 124, char: 0x1e2 }])).toEqual(['124:1e2'])
    expect(strays([...body, { oam: 90, char: 0x1e4 }])).toEqual(['90:1e4'])
    expect(strays([...body, { oam: 127, char: 0x16e }])).toEqual(['127:16e'])
  })
})

describe.skipIf(!hasRom(VANILLA))('vanilla grinders carry no castle flames (#793 B)', () => {
  for (const slot of [0x1f, 0x1a]) {
    it(`map $${slot.toString(16)}: every pass of every $67 is its four body pieces only`, () => {
      const path = romPath(VANILLA)
      const bytes = new Uint8Array(readFileSync(path))
      const rom = new SmwRom(RomFile.fromBytes(path, Buffer.from(bytes)))
      const built = new L1ModelCache().get(bytes, path, slot, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
      if (!built.ok) throw new Error(built.reason)
      const data = readStream(rom.rom, rom.getLevelSpritePointer(slot)!)
      const grinders = parseLevelSprites(data, built.inputs.isVertical).filter(x => x.spriteId === 0x67) // prettier-ignore
      expect(grinders).toHaveLength(slot === 0x1f ? 7 : 13)
      let seen = 0
      const draw = interpDrawer(rom.rom, slot, built.inputs, (r, id, sd) => {
        const m = runOnce(r, id, sd)
        m.passes.forEach((p, pi) => {
          expect(strays(p.parts), `pass ${pi}`).toEqual([])
          if (p.parts.length > 0) expect(p.parts, `pass ${pi}`).toHaveLength(4)
          seen += p.parts.length
        })
        return m
      })
      grinders.forEach(g => draw(g))
      // 10 of 13 $1A and 7 of 7 $1F grinders draw; a run that drew nothing would pass the loop above.
      expect(seen).toBeGreaterThan(0)
    }, 300_000)
  }

  it('map $1f: the reply puts the flames in their own layer-2 sprites and every drawn grinder box is 32 x 32', () => {
    const path = romPath(VANILLA)
    const bytes = new Uint8Array(readFileSync(path))
    const r = mapSprites(new L1ModelCache(), bytes, path, 0x1f)
    if (r.status !== 'ok') throw new Error(r.status)
    const drawn = r.sprites.filter(d => d.id === 0x67 && d.status === 'drawn')
    expect(drawn).toHaveLength(7)
    for (const d of drawn) expect([d.box.x1 - d.box.x0, d.box.y1 - d.box.y0], `(${d.x},${d.y})`).toEqual([32, 32]) // prettier-ignore
    const flames = r.sprites.filter(d => d.fixedTo === 'layer2')
    expect(flames).toHaveLength(24)
    expect(new Set(flames.map(d => d.id))).toEqual(new Set([0xe6]))
  }, 300_000)
})
