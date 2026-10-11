/**
 * #809: a level's cluster sprites must not be drawn as part of the sprite under
 * test. The game's sprite loop runs the cluster sprites after the twelve slots
 * when ActivateClusterSprite ($18B8) is set (CODE_01808C, SMWDisX
 * bank_01.asm:128-130), and the level loader leaves them set up (the castle
 * flames of map $101 write OAM 124-127, plus 123 as an overflow copy when a
 * flame's X is $F0 or more, CODE_02FA16, bank_02.asm:16221-16278).
 *
 * Synthetic, no ROM: the synthetic cart's sprite loop gains that cluster call,
 * its level data loader spawns a cluster sprite in each of the 20 cluster cells in
 * turn (one cart per cell), and the cluster routine, when that cell holds a number,
 * writes a tile into OAM slots 123-127. Id 40 sets $18B8 itself, so only the
 * cleared numbers keep the level's cluster sprites from running for it.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import { interpDrawer } from '../../../../theia/extension/src/node/map-sprites'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const LEVEL = 0x105
const CLUSTER_TILE = 0xaa
const SLOTS = [123, 124, 125, 126, 127]
/** The OAM entry synthetic id 0 draws into (its $0300-page store, syntheticSpriteRom.ts). */
const OWN = 64
/** A synthetic id whose MAIN sets ActivateClusterSprite, then draws as id 0 does. */
const SETS_FLAG = 40

/** The 20 ClusterSpriteNumber cells, $1892-$18A5 (rammap.asm:1855). */
const CELLS = Array.from({ length: 20 }, (_, i) => 0x1892 + i)

/** `cell` is the one ClusterSpriteNumber cell the level loader sets and the cluster routine reads. */
function clusterRom(cell: number): RomFile {
  const bytes = new Uint8Array(buildSyntheticRom().buffer)
  const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)
  // `tail` bytes replace the base cart's own return; every byte past them must be free.
  const put = (snes: number, b: number[], tail = 0) => {
    expect(bytes.subarray(off(snes) + tail, off(snes) + b.length).every(v => v === 0)).toBe(true)
    bytes.set(b, off(snes))
  }
  // Sprite loop tail, after the countdown: LDA $18B8 / BEQ +4 / JSL $02F808 / PLB / RTL.
  put(0x01808c + 17, [0xad, 0xb8, 0x18, 0xf0, 0x04, 0x22, 0x08, 0xf8, 0x02, 0xab, 0x6b], 2)
  // The cluster routine: X = Y = $50, tile $AA in slots 123-127 (bytes $03EC-$03FF), RTL.
  const at = (slot: number, k: number) => 0x200 + slot * 4 + k
  const sta = (a: number) => [0x8d, a & 0xff, a >> 8]
  // LDA cell / NOP x3 / BEQ to the RTL: runs only while that one cell holds a number.
  put(0x02f808, [
    ...[0xad, cell & 0xff, cell >> 8], 0xea, 0xea, 0xea, 0xf0, 49,
    0xa9, 0x50, ...SLOTS.flatMap(s => [...sta(at(s, 0)), ...sta(at(s, 1))]),
    0xa9, CLUSTER_TILE, ...SLOTS.flatMap(s => sta(at(s, 2))),
    0x6b,
  ]) // prettier-ignore
  // Level data loader tail: JSL a stub that spawns one cluster sprite, then its own PLP / RTL.
  put(0x05801e + 18, [0x22, 0x00, 0xf1, 0x05, 0x28, 0x6b], 2)
  // LDA #1 / STA $18B8 / LDA #5 / STA cell / RTL, as the vanilla loader leaves map $101.
  put(0x05f100, [0xa9, 0x01, ...sta(0x18b8), 0xa9, 0x05, ...sta(cell), 0x6b])
  // Id 40's MAIN pointer (table at $01:8329) to LDA #1 / STA $18B8 / JMP id 0's MAIN ($8640).
  put(0x018329 + SETS_FLAG * 2, [0x00, 0x98], 2)
  put(0x019800, [0xa9, 0x01, ...sta(0x18b8), 0x4c, 0x40, 0x86])
  return RomFile.fromBytes('cluster.sfc', bytes)
}

const oamOf = (m: ReturnType<typeof runOnce>) =>
  m.chosen === undefined ? [] : m.passes[m.chosen]!.parts.map(p => p.oam).sort((a, b) => a - b)

describe('cluster sprites in the level image (#809)', () => {
  // One cart per cell, so removing the clear of any single cell leaves a cluster sprite running.
  const carts = CELLS.map(cell => {
    const rom = clusterRom(cell)
    return { cell, rom, seed: levelSeed(rom, LEVEL) }
  })

  it.each(carts)(
    'cell $cell: the fixture spawns a cluster sprite that writes OAM 123-127',
    ({ cell, rom, seed }) => {
      expect(seed.loaded?.[0x18b8]).toBe(1)
      expect(seed.loaded?.[cell]).toBe(5)
      // Run on the loader's image alone (no run-alone override): the leak this test guards is real.
      const raw = runOnce(rom, 0, withSeed({ loaded: seed.loaded! }))
      expect(oamOf(raw)).toEqual([OWN, ...SLOTS])
    },
  )

  it.each(carts)(
    'cell $cell: a sprite run from the level seed draws only the OAM it wrote',
    ({ rom, seed }) => {
      expect(oamOf(runOnce(rom, 0, seed))).toEqual([OWN])
    },
  )

  it.each(carts)(
    'cell $cell: a sprite that sets ActivateClusterSprite itself still runs none of the level cluster sprites',
    ({ rom, seed }) => {
      // The fixture: with the loader's numbers kept, id 40's own flag runs them.
      const kept = withSeed({ loaded: seed.loaded! })
      expect(oamOf(runOnce(rom, SETS_FLAG, kept))).toEqual([OWN, ...SLOTS])
      expect(oamOf(runOnce(rom, SETS_FLAG, seed))).toEqual([OWN])
    },
  )

  it.each(carts)('cell $cell: the map view draws no cluster tile into the sprite', ({ rom }) => {
    const sprite: LevelSprite = { screen: 0, x: 8, y: 8, spriteId: 0, extraBit: false, raw: [0, 0, 0], index: 0, streamOffset: 1 } // prettier-ignore
    const res = interpDrawer(rom, LEVEL, { isVertical: false, screenCount: 20 })(sprite)
    if (!res.ok) throw new Error('reason' in res ? res.reason : res.failure.kind)
    expect(res.parts).toHaveLength(4) // one 16 x 16 piece
    expect(res.parts.some(p => (p.charNum & 0xff) === CLUSTER_TILE)).toBe(false)
  })
})
