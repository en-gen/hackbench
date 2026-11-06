/**
 * #1230 on the vanilla ROM (corpus): the capture on map $00F (Mesen 2, one machine, 4 of 4 runs: odd columns 205 and 241 in
 * slot 7, long; even columns 164, 186, 210, 216 short) and maps $0DD, $12A, $12C (UNCAPTURED: the rule's output, not a
 * capture); then edited working-copy bytes: the rope redraws when it moves a column or the map's
 * setting changes (AC 6), a vertical map takes the row parity, a refused level loader or a repointed handler is told or
 * left alone, the Properties frames match the map and the rope draws a free-slot setting at its short length.
 * Evidence scope: vanilla US ROM, emulated CPU, one machine; none of these is a capture.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loromToOffset } from '../../../../src/rom/addressing'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { drawnParts } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { spriteProps } from '../../../../theia/extension/src/browser/sprite-props'
import { resolveLoop, resolveTables } from '../../../../src/rom/sprites/interp/SpriteDispatch'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import {
  mapSpriteFrames,
  mapSprites,
  runWithUploads,
} from '../../../../theia/extension/src/node/map-sprites'
import { hasRom, romPath, VANILLA } from '../../support/corpus'

type Edit = (bytes: Uint8Array, stream: number) => void
const load = (map: number, edit?: Edit) => {
  const path = romPath(VANILLA)
  const bytes = new Uint8Array(readFileSync(path))
  const rom = new SmwRom(RomFile.fromBytes(path, Buffer.from(bytes)))
  edit?.(bytes, loromToOffset(rom.getLevelSpritePointer(map)!, bytes.length)!)
  return { path, bytes }
}
const sprites = (map: number, edit?: Edit) => {
  const { path, bytes } = load(map, edit)
  const r = mapSprites(new L1ModelCache(), bytes, path, map)
  if (r.status !== 'ok') throw new Error(`map ${map}: ${r.status}`)
  return r
}
const ropes = (map: number, edit?: Edit) =>
  sprites(map, edit).sprites.filter(s => s.id === 0x64).map(s => ({ col: s.x / 16, row: s.y / 16, tiles: (s.parts?.length ?? 0) / 4, s })) // prettier-ignore
/** Sets the map's sprite memory setting: the low 6 bits of the stream's first byte (bank_05.asm:7259-7261). */
const setting =
  (n: number): Edit =>
  (b, at) =>
    (b[at] = (b[at]! & 0xc0) | n)

describe.skipIf(!hasRom(VANILLA))('the rope on edited vanilla bytes', () => {
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
  it('a vertical map: the first sprite replaced by a rope on row 5, setting 1, draws 9 tiles; on row 4, 5', () => {
    const plant = (row: number): Edit => (b, at) => { setting(1)(b, at); b.set([0x20, (row << 4) | 0, 0x64], at + 1) } // prettier-ignore
    expect(sprites(0x0c2, plant(5)).orientation).toBe('vertical')
    expect(ropes(0x0c2, plant(5)).find(r => r.row === 5)!.tiles).toBe(9)
    expect(ropes(0x0c2, plant(4)).find(r => r.row === 4)!.tiles).toBe(5)
  })
  it('map $00F set to setting 2: the rope at column 205 is the short 5 (its top slot is shared); setting 0: all 5', () => {
    expect(ropes(0x00f, setting(2)).find(r => r.col === 205)!.tiles).toBe(5)
    for (const r of ropes(0x00f, setting(0))) expect(r.tiles, `column ${r.col}`).toBe(5)
  })
  it('AC 6: a rope moved one column right redraws at the other length, and the old column is gone', () => {
    const find = (b: Uint8Array, at: number) => { for (let i = at + 1; b[i] !== 0xff; i += 3) if (b[i + 2] === 0x64 && (b[i + 1]! & 0xf) === 10 && b[i + 1]! >> 4 === 4) return i + 1; throw new Error('no rope') } // prettier-ignore
    expect(ropes(0x00f).find(r => r.col === 164)!.tiles).toBe(5)
    const moved = ropes(0x00f, (b, at) => (b[find(b, at)]! += 0x10))
    expect(moved.find(r => r.col === 164)).toBeUndefined()
    expect(moved.find(r => r.col === 165)!.tiles).toBe(9)
  })
  it('AC 6: Properties frames carry the map tile count for a long and a short rope', () => {
    const { path, bytes } = load(0x00f)
    const r = mapSprites(new L1ModelCache(), bytes, path, 0x00f)
    if (r.status !== 'ok') throw new Error(r.status)
    for (const [col, tiles] of [
      [205, 9],
      [164, 5],
    ] as const) {
      const s = r.sprites.find(q => q.id === 0x64 && q.x / 16 === col)!
      const f = mapSpriteFrames(new L1ModelCache(), bytes, path, 0x00f, s.index)
      expect(f.status).toBe('ok')
      if (f.status === 'ok')
        expect((f.frames[0]!.parts?.length ?? 0) / 4, `column ${col}`).toBe(tiles)
    }
  })
  it('a refused level loader keeps the rope at 5 tiles and the panel says so', () => {
    const { path, bytes } = load(0x00f)
    bytes[0x2801e] = 0 // the byte at $05:801E
    const r = mapSprites(new L1ModelCache(), bytes, path, 0x00f)
    if (r.status !== 'ok') throw new Error(r.status)
    const got = r.sprites.filter(s => s.id === 0x64)
    expect(got.length).toBeGreaterThan(0)
    for (const s of got) {
      expect((s.parts?.length ?? 0) / 4).toBe(5)
      expect(s.note).toMatch(/level loader could not be run/)
    }
  })
  it('a rope draw edited so the gate refuses it draws 5 tiles in slot 0 and the panel says why', () => {
    const { path, bytes } = load(0x00f)
    bytes[0xdc74] = 5 // the operand of the draw's CPX #6 (bank_01.asm:12584, $01:DC74)
    const r = mapSprites(new L1ModelCache(), bytes, path, 0x00f)
    if (r.status !== 'ok') throw new Error(r.status)
    const got = r.sprites.filter(s => s.id === 0x64)
    expect(got).toHaveLength(6)
    for (const s of got) {
      expect((s.parts?.length ?? 0) / 4, `column ${s.x / 16}`).toBe(5)
      expect(s.note).toBe(
        'Not checked against the sprite loader on this ROM, so its length in play may differ.',
      )
      expect(s.unverified).toMatch(/slot 0: it calls \$01DC54/) // the gate's own reason stays on the tooltip
    }
  })
  it('a $64 whose main and INIT pointers are those of sprite $0F is not a rope: no length note', () => {
    const { path, bytes } = load(0x00f)
    const rom = RomFile.fromBytes(path, Buffer.from(bytes))
    const loop = resolveLoop(rom)
    const t = loop.ok ? resolveTables(rom, loop.handle) : null
    if (!t?.ok) throw new Error('tables')
    for (const table of [t.tables.mainTable, t.tables.initTable]) {
      const at = loromToOffset(table, bytes.length)!
      bytes.set(bytes.subarray(at + 0x0f * 2, at + 0x0f * 2 + 2), at + 0x64 * 2)
    }
    const r = mapSprites(new L1ModelCache(), bytes, path, 0x00f)
    if (r.status !== 'ok') throw new Error(r.status)
    for (const s of r.sprites.filter(q => q.id === 0x64))
      expect(s.note ?? '', `column ${s.x / 16}`).not.toMatch(/rope is shown/)
  })
})
