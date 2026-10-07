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
import { SPRITE_BASE_TILE_OVERRIDES } from '../../../../src/rom/SpriteTileLoader'
import { RomFile } from '../../../../src/rom/RomFile'
import { walkHandler } from '../../../../src/rom/dispatch/HandlerWalk'
import { resolveHandlerSite } from '../../../../src/rom/dispatch/GfxRoutineReader'
import { CORPUS, freshRom, hasRoms } from '../../support/corpus'

const romsPresent = hasRoms()
const allRoms = () => CORPUS.map(name => ({ name, rom: freshRom(name) }))

const FROZEN: Readonly<Record<number, number>> = SPRITE_BASE_TILE_OVERRIDES

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

  // The move from 35/58 to 36/57 is a coincidence: $7E's correct tile ($E8)
  // equals the first store the walk reads (LDA #$E8 in CoinSprGfxSub, bank_01.asm:9564).
  it('matches 36, differs on 57 and finds no store for 5, on every cart', () => {
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
      expect({ match, differ, absent }, name).toEqual({ match: 36, differ: 57, absent: 5 })
    }
  })

  it('blames a shared OAM preamble for most of the 58, which is why', () => {
    // $82 is not any sprite's tile. It comes from a preamble the handler
    // runs before its own tile write, so "first store reached" is not
    // "first store a human reading the routine would call the sprite's".
    //
    // The count is per cart, unlike the 36/57/5 split above: vanilla,
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

  it('does not recover the PowerUpTiles ids $74-$78 from the first store', () => {
    // $74-$78 read `PowerUpTiles` at indices 0 to 4; the index is
    // SpriteNumber - $74 (bank_01.asm:9632-9636), computed at run time from
    // the sprite id, so a static first-store read cannot apply it. On five carts the
    // walk returns $82 for $74-$76 and $78 and $E8 for $77.
    for (const { name, rom } of allRoms()) {
      const right = [0x74, 0x75, 0x76, 0x77, 0x78].filter(
        id => firstBaseTile(rom, id) === FROZEN[id],
      )
      expect(right.length, name).toBeLessThanOrEqual(1)
    }
  })
})
