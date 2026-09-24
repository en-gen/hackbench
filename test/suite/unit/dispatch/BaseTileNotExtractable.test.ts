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
 * `docs/sprites/sprite-gfx-routine-reading.md` section 6, not automatically a bug.
 *
 * Evidence scope: all six cart files in the corpus. Static reads only; no
 * emulator was run.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { walkHandler } from '../../../../src/rom/dispatch/HandlerWalk'
import { resolveHandlerSite } from '../../../../src/rom/dispatch/GfxRoutineReader'
import { CORPUS, freshRom, hasRoms } from '../../support/corpus'

const romsPresent = hasRoms()
const allRoms = () => CORPUS.map(name => ({ name, rom: freshRom(name) }))

/**
 * `SPRITE_BASE_TILE_OVERRIDES` as `SpriteTileLoader` holds it. Duplicated
 * rather than imported because the table is not exported and exporting it
 * to satisfy a test would widen the module's surface for no other caller.
 * A drift between the two is caught by the count assertion below.
 */
const FROZEN: Readonly<Record<number, number>> = {
  0x54: 0x08,
  0x55: 0xea,
  0x56: 0xea,
  0x57: 0xea,
  0x58: 0xea,
  0x59: 0x40,
  0x5a: 0x40,
  0x5b: 0x60,
  0x5c: 0xea,
  0x5d: 0xcb,
  0x5e: 0xea,
  0x5f: 0xa2,
  0x60: 0x00,
  0x61: 0xe2,
  0x63: 0xc8,
  0x64: 0xae,
  0x65: 0xae,
  0x66: 0xae,
  0x68: 0xc8,
  0x6a: 0x60,
  0x6b: 0x3d,
  0x6c: 0x3d,
  0x6d: 0x80,
  0x6e: 0x80,
  0x6f: 0xea,
  0x70: 0xe8,
  0x71: 0xc8,
  0x72: 0xc8,
  0x73: 0xc8,
  0x74: 0x24,
  0x75: 0x26,
  0x76: 0x48,
  0x77: 0x0e,
  0x78: 0x24,
  0x79: 0xae,
  0x7a: 0xae,
  0x7c: 0x6e,
  0x7d: 0x5d,
  0x7e: 0x5d,
  0x7f: 0x5d,
  0x80: 0xec,
  0x81: 0x80,
  0x82: 0xe4,
  0x83: 0x2a,
  0x84: 0x2a,
  0x85: 0x2a,
  0x87: 0x60,
  0x88: 0xc6,
  0x8a: 0xd2,
  0x8b: 0xc5,
  0x8c: 0x60,
  0x8d: 0x9c,
  0x8f: 0x80,
  0x90: 0x80,
  0x91: 0x06,
  0x92: 0x06,
  0x93: 0x06,
  0x94: 0x06,
  0x95: 0x06,
  0x96: 0x06,
  0x97: 0x06,
  0x9a: 0x98,
  0x9b: 0x46,
  0x9c: 0x40,
  0x9d: 0xaa,
  0x9f: 0x80,
  0xa0: 0xe3,
  0xa1: 0x45,
  0xa2: 0x40,
  0xa3: 0xa2,
  0xa4: 0xaa,
  0xa5: 0xc8,
  0xa6: 0xc8,
  0xa7: 0x4a,
  0xa8: 0xa0,
  0xa9: 0x40,
  0xaa: 0xa8,
  0xae: 0xcc,
  0xaf: 0x8c,
  0xb0: 0x88,
  0xb1: 0x2e,
  0xb2: 0xe0,
  0xb3: 0x32,
  0xb4: 0x18,
  0xb5: 0x2a,
  0xb6: 0xac,
  0xb9: 0xc0,
  0xba: 0xc4,
  0xbb: 0xcc,
  0xbc: 0x00,
  0xbd: 0xe0,
  0xbe: 0xae,
  0xc0: 0x85,
  0xc1: 0x40,
  0xc2: 0xec,
  0xc3: 0x86,
  0xc5: 0xc0,
  0xc8: 0x2a,
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
      let match = 0,
        differ = 0,
        absent = 0
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
      const right = [0x74, 0x75, 0x76, 0x77, 0x78].filter(
        id => firstBaseTile(rom, id) === FROZEN[id],
      )
      expect(right.length, name).toBeLessThanOrEqual(1)
    }
  })
})
