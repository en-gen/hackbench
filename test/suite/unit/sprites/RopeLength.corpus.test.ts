/**
 * #1230 on the vanilla ROM: the rope ($64) on the maps that place it, through the node-side map view (`mapSprites`).
 * Ground truth: Mesen 2 capture on map $00F, one machine, 4 of 4 runs: odd columns 205 and 241 in slot 7 (long); even
 * columns 164, 186, 210 and 216 short. Maps $0DD, $12A and $12C are UNCAPTURED: the test pins what the interpreter draws
 * there (the rule's output), not a capture. Evidence scope: vanilla US ROM, emulated CPU, one machine.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { mapSprites } from '../../../../theia/extension/src/node/map-sprites'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { drawnParts } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { spriteProps } from '../../../../theia/extension/src/browser/sprite-props'
import { runWithUploads } from '../../../../theia/extension/src/node/map-sprites'
import { hasRom, romPath, VANILLA } from '../../support/corpus'

const ropes = (map: number, edit?: (b: Uint8Array) => void) => {
  const path = romPath(VANILLA)
  const bytes = new Uint8Array(readFileSync(path))
  edit?.(bytes)
  const r = mapSprites(new L1ModelCache(), bytes, path, map)
  if (r.status !== 'ok') throw new Error(`map ${map}: ${r.status}`)
  return r.sprites.filter(s => s.id === 0x64).map(s => ({ col: s.stored ? s.stored.x / 16 : s.x / 16, tiles: (s.parts?.length ?? 0) / 4, s })) // prettier-ignore
}

describe.skipIf(!hasRom(VANILLA))('the rope on the vanilla ROM', () => {
  it('map $00F (setting 1): odd columns 9 tiles, even columns 5, as captured', () => {
    const got = Object.fromEntries(ropes(0x00f).map(r => [r.col, r.tiles]))
    for (const c of [205, 241]) expect(got[c], `column ${c}`).toBe(9)
    for (const c of [164, 186, 210, 216]) expect(got[c], `column ${c}`).toBe(5)
  })
  it('uncaptured maps $0DD, $12A, $12C: the lengths the rule gives (not graded against a capture)', () => {
    for (const m of [0x0dd, 0x12a, 0x12c]) {
      const got = ropes(m)
      expect(got.length, `map ${m.toString(16)}`).toBeGreaterThan(0)
      // Observed output of the rule (even columns, or a setting 0 map for $12A's column 13): not a capture.
      for (const r of got) expect(r.tiles, `map ${m.toString(16)} column ${r.col}`).toBe(5)
    }
  })
  it('an edited loader keeps slot 0: every rope draws 5 tiles and says why (AC 7)', () => {
    const got = ropes(0x00f, b => (b[0x128e4 + 3]! ^= 1))
    expect(got.map(r => r.tiles)).toEqual([5, 5, 5, 5, 5, 5])
    expect(got[0]!.s.unverified).toMatch(/loader.*not the original/)
    // The Properties panel itself says why, in plain words, not only on a tooltip.
    for (const r of got) expect(spriteProps(r.s).notes.join(' ')).toMatch(/The rope is shown at its short length: the sprite loader on this ROM is not the original one./) // prettier-ignore
  })
  it('the slot moves no part of the first frame: the short and long runs share their tiles and their anchor (case 1)', () => {
    const path = romPath(VANILLA)
    const rom = new SmwRom(RomFile.fromBytes(path, readFileSync(path)))
    const base = levelSeed(rom.rom, 0x00f)
    const at = (slot: number) => runWithUploads(rom.rom, 0x64, withSeed({ slot, sprite: { x: 164 * 16, y: 0x40 }, camera: { x: 164 * 16 - 128, y: 0 } }, base)) // prettier-ignore
    const [short, long] = [at(5), at(7)]
    expect(short.refusal).toBeUndefined()
    expect([long.chosen, long.anchor?.x, long.anchor?.y]).toEqual([
      short.chosen,
      short.anchor?.x,
      short.anchor?.y,
    ])
    const key = (p: { dx: number; dy: number }) => `${p.dx},${p.dy}`
    const [s, l] = [drawnParts(short.passes[short.chosen!]!).map(key), drawnParts(long.passes[long.chosen!]!).map(key)] // prettier-ignore
    expect([s.length, l.length]).toEqual([5, 9])
    expect(s.every(k => l.includes(k))).toBe(true)
  })
})
