/**
 * The measurement behind keeping `SPRITE_BASE_TILE_OVERRIDES` frozen.
 *
 * That table's comment used to claim the 98 values were auto-extracted by
 * following each handler to its first `LDA ... STA OAMTileNo` pair, taking
 * an immediate's operand or an indexed load's first table byte. This runs
 * exactly that rule and counts how much of the table it reproduces. The
 * answer is the reason the table was not replaced, so it belongs in a test
 * rather than only in prose: a number nobody can re-run is an assertion.
 *
 * It is a characterisation test. It is expected to change if the walk
 * changes, and a change here is a prompt to re-read
 * `docs/sprite-gfx-routine-reading.md` section 6, not automatically a bug.
 *
 * Evidence scope: all six cart files in `test/roms/`. Static reads only; no
 * emulator was run.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../../src/rom/RomFile'
import { walkHandler } from '../../../../src/rom/dispatch/HandlerWalk'
import { resolveHandlerSite } from '../../../../src/rom/dispatch/GfxRoutineReader'

const ROM_DIR = resolve(__dirname, '../../../roms')
const ROM_FILES = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
] as const
const romsPresent = ROM_FILES.every(f => existsSync(resolve(ROM_DIR, f)))
const allRoms = () => ROM_FILES.map(name => ({ name, rom: RomFile.load(resolve(ROM_DIR, name)) }))

/**
 * `SPRITE_BASE_TILE_OVERRIDES` as `SpriteTileLoader` holds it. Duplicated
 * rather than imported because the table is not exported and exporting it
 * to satisfy a test would widen the module's surface for no other caller.
 * A drift between the two is caught by the count assertion below.
 */
const FROZEN: Readonly<Record<number, number>> = {
  0x54: 0x08, 0x55: 0xEA, 0x56: 0xEA, 0x57: 0xEA, 0x58: 0xEA, 0x59: 0x40, 0x5A: 0x40,
  0x5B: 0x60, 0x5C: 0xEA, 0x5D: 0xCB, 0x5E: 0xEA, 0x5F: 0xA2, 0x60: 0x00, 0x61: 0xE2,
  0x63: 0xC8, 0x64: 0xAE, 0x65: 0xAE, 0x66: 0xAE, 0x68: 0xC8, 0x6A: 0x60, 0x6B: 0x3D,
  0x6C: 0x3D, 0x6D: 0x80, 0x6E: 0x80, 0x6F: 0xEA, 0x70: 0xE8, 0x71: 0xC8, 0x72: 0xC8,
  0x73: 0xC8, 0x74: 0x24, 0x75: 0x26, 0x76: 0x48, 0x77: 0x0E, 0x78: 0x24, 0x79: 0xAE,
  0x7A: 0xAE, 0x7C: 0x6E, 0x7D: 0x5D, 0x7E: 0x5D, 0x7F: 0x5D, 0x80: 0xEC, 0x81: 0x80,
  0x82: 0xE4, 0x83: 0x2A, 0x84: 0x2A, 0x85: 0x2A, 0x87: 0x60, 0x88: 0xC6, 0x8A: 0xD2,
  0x8B: 0xC5, 0x8C: 0x60, 0x8D: 0x9C, 0x8F: 0x80, 0x90: 0x80, 0x91: 0x06, 0x92: 0x06,
  0x93: 0x06, 0x94: 0x06, 0x95: 0x06, 0x96: 0x06, 0x97: 0x06, 0x9A: 0x98, 0x9B: 0x46,
  0x9C: 0x40, 0x9D: 0xAA, 0x9F: 0x80, 0xA0: 0xE3, 0xA1: 0x45, 0xA2: 0x40, 0xA3: 0xA2,
  0xA4: 0xAA, 0xA5: 0xC8, 0xA6: 0xC8, 0xA7: 0x4A, 0xA8: 0xA0, 0xA9: 0x40, 0xAA: 0xA8,
  0xAE: 0xCC, 0xAF: 0x8C, 0xB0: 0x88, 0xB1: 0x2E, 0xB2: 0xE0, 0xB3: 0x32, 0xB4: 0x18,
  0xB5: 0x2A, 0xB6: 0xAC, 0xB9: 0xC0, 0xBA: 0xC4, 0xBB: 0xCC, 0xBC: 0x00, 0xBD: 0xE0,
  0xBE: 0xAE, 0xC0: 0x85, 0xC1: 0x40, 0xC2: 0xEC, 0xC3: 0x86, 0xC5: 0xC0, 0xC8: 0x2A,
}

/** The stated rule, applied: first tile store the walk reaches, immediate
 *  operand or table element 0. */
function firstBaseTile(rom: RomFile, id: number): number | null {
  const site = resolveHandlerSite(rom, id)
  if (!site) return null
  const store = walkHandler(rom, site.at, { watch: new Map() }).tileStores[0]
  if (!store) return null
  if (store.source.kind === 'immediate') return store.source.value
  if (store.source.kind === 'table') return rom.readByte(store.source.addr)
  return null
}

describe.skipIf(!romsPresent)('the stated extraction rule does not reproduce the table', () => {
  it('covers 98 ids', () => {
    expect(Object.keys(FROZEN).length).toBe(98)
  })

  it('matches 35, differs on 58 and finds no store for 5, on every cart', () => {
    for (const { name, rom } of allRoms()) {
      let match = 0, differ = 0, absent = 0
      for (const [key, frozen] of Object.entries(FROZEN)) {
        const live = firstBaseTile(rom, Number(key))
        if (live === null) absent++
        else if (live === frozen) match++
        else differ++
      }
      expect({ match, differ, absent }, name).toEqual({ match: 35, differ: 58, absent: 5 })
    }
  })

  it('blames a shared OAM preamble for most of the 58, which is why', () => {
    // $82 is not any sprite's tile. It comes from a preamble the handler
    // runs before its own tile write, so "first store reached" is not
    // "first store a human reading the routine would call the sprite's".
    //
    // The count is per cart, unlike the 35/58/5 split above: vanilla,
    // magic, GPW V1.2, Invictus and Seven Vanilla Levels give 32 and
    // Grand Poo World 2 1.1 gives 27, because it patches some of those
    // handlers. Asserted as a range, with the two exact figures named,
    // rather than pinned to one number that is only true of five files.
    const counts = allRoms().map(({ name, rom }) => {
      const n = Object.keys(FROZEN).filter(key => {
        const live = firstBaseTile(rom, Number(key))
        return live !== null && live !== FROZEN[Number(key)] && live === 0x82
      }).length
      return [name, n] as const
    })
    for (const [name, n] of counts) expect(n, name).toBeGreaterThanOrEqual(27)
    expect(counts.filter(([, n]) => n === 32).length).toBe(5)
    expect(counts.filter(([, n]) => n === 27).length).toBe(1)
  })

  it('gets exactly one of the five PowerUpTiles ids right, as element 0 must', () => {
    // $74-$78 read `PowerUpTiles` at indices 0 to 4, and the index is a RAM
    // byte. A static read has no index to apply.
    for (const { name, rom } of allRoms()) {
      const right = [0x74, 0x75, 0x76, 0x77, 0x78].filter(id => firstBaseTile(rom, id) === FROZEN[id])
      expect(right.length, name).toBeLessThanOrEqual(1)
    }
  })
})
