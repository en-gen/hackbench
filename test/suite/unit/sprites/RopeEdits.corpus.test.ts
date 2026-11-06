/**
 * #1230 on the vanilla ROM with edited working-copy bytes (corpus): the rope redraws when it moves a column or the map's
 * setting changes (AC 6), a vertical map takes the row parity, a refused level loader or a repointed handler is told or
 * left alone, the Properties frames match the map, and the door tags the extra length on the REAL draw across every setting.
 * Evidence scope: vanilla US ROM, emulated CPU, one machine; none of these is a capture.
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { loromToOffset } from '../../../../src/rom/addressing'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { ropeModel } from '../../../../src/rom/sprites/interp/RopeLength'
import { slotWalk } from '../../../../src/rom/sprites/interp/SlotPick'
import { resolveLoop, resolveTables } from '../../../../src/rom/sprites/interp/SpriteDispatch'
import { drawnParts } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
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

describe.skipIf(!hasRom(VANILLA))('the door on the real draw (door: true), every setting', () => {
  it('tags exactly the parts only the long run drew, in every setting and parity, 0 to 18 (smoke sweep, not coverage)', () => {
    const rom = RomFile.load(romPath(VANILLA))
    let tagged = 0
    for (let s = 0; s <= 18; s++)
      for (const col of [0x40, 0x41]) {
        const [x, y] = [col * 16, 0x40]
        const runAt = (slot: number) => runWithUploads(rom, 0x64, withSeed({ slot, sprite: { x, y }, camera: { x: x - 128, y: 0 }, level: { ...SPRITE_SEED.level, spriteMemory: s } }, SPRITE_SEED)) // prettier-ignore
        const w = slotWalk(rom, s, 0x64, x)
        expect(w.status, `setting ${s}`).toBe('ok')
        if (w.status !== 'ok') continue
        const m = ropeModel(rom, { id: 0x64, setting: s, x, y, vertical: false, door: true }, runAt)
        const [long, short] = [runAt(w.long), runAt(w.short)]
        const keys = (r: typeof long) =>
          new Set(drawnParts(r.passes[r.chosen!]!).map(p => `${p.dx},${p.dy}`))
        const extra = [...keys(long)].filter(k => !keys(short).has(k)).length
        const door = m.passes[m.chosen!]!.parts.filter(p => p.door).length
        expect(door, `setting ${s} column ${col}`).toBe(extra)
        tagged += door
      }
    expect(tagged, 'some setting has an extra length to tag').toBeGreaterThan(0)
  }, 120_000)
})
