import { describe, it, expect, beforeEach } from 'vitest'
import { existsSync } from 'fs'
import { loadVram } from '../../../../src/rom/GfxLoader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildChars } from '../../../../src/rom/model/chars/CharFactory'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { Tile, type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { buildTiles } from '../../../../src/rom/model/tiles/TileFactory'
import { InvisibleBlockRevealBehavior } from '../../../../src/rom/model/tiles/behaviors/InvisibleBlockRevealBehavior'
import type { CellBox } from '../../../../src/rom/model/RenderTarget'
import { makeTestMapStore, resetEditorStore } from '../fixtures/stores'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

function makeQuad(tag: number): SubtileQuad {
  const sub = () =>
    new SubTile(
      new Char(tag, new StaticPixelsBehavior(new Uint8Array(64))),
      0,
      false,
      false,
      false,
    )
  return [sub(), sub(), sub(), sub()]
}

describe('InvisibleBlockRevealBehavior behavior', () => {
  beforeEach(resetEditorStore)

  it('returns the revealed quad', () => {
    const quad = makeQuad(1)
    const b = new InvisibleBlockRevealBehavior(quad)
    expect(b.selectQuad()).toBe(quad)
  })

  it('selectAlpha returns the default 0.5', () => {
    const b = new InvisibleBlockRevealBehavior(makeQuad(1))
    expect(b.selectAlpha()).toBe(0.5)
  })

  it('respects a custom alpha override', () => {
    const b = new InvisibleBlockRevealBehavior(makeQuad(1), null, 0.25)
    expect(b.selectAlpha()).toBe(0.25)
  })

  it('rewardOverlayQuad defaults to null', () => {
    const b = new InvisibleBlockRevealBehavior(makeQuad(1))
    expect(b.rewardOverlayQuad).toBeNull()
  })

  it('stores the reward overlay quad when provided', () => {
    const reveal = makeQuad(1)
    const reward = makeQuad(2)
    const b = new InvisibleBlockRevealBehavior(reveal, reward)
    expect(b.rewardOverlayQuad).toBe(reward)
  })
})

describe.skipIf(!existsSync(ROM_PATH))('TileFactory invisible-block reveal wiring (vanilla ROM)', () => {
  beforeEach(resetEditorStore)

  it('$021 wears InvisibleBlockRevealBehavior with the $123 reveal + $02B coin overlay', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0x024)!
    const header = parseLevelHeader(raw)
    const vram = loadVram(rom.rom, header.objectTileset, header.spriteSet)
    const chars = buildChars(vram)
    const tiles = buildTiles(rom.rom, header.objectTileset, chars)
    const mapStore = makeTestMapStore()

    const tile = tiles.get(0x021)
    expect(tile, 'tile $021').toBeInstanceOf(Tile)
    expect(tile!.behavior, 'behavior of $021').toBeInstanceOf(InvisibleBlockRevealBehavior)

    const revealBehavior = tile!.behavior as InvisibleBlockRevealBehavior
    const cell = { tl: { x: 0, y: 0 }, br: { x: 16, y: 16 } } as unknown as CellBox

    // Reveal quad must match tile $123 (visible ? coin block graphic).
    const visibleCoin = tiles.get(0x123)
    expect(visibleCoin, 'tile $123').toBeInstanceOf(Tile)
    expect(revealBehavior.revealedQuad).toEqual(
      visibleCoin!.behavior.selectQuad(cell, mapStore),
    )

    // Reward overlay quad must match tile $02B (coin).
    const coin = tiles.get(0x02B)
    expect(coin, 'tile $02B').toBeInstanceOf(Tile)
    expect(revealBehavior.rewardOverlayQuad).toEqual(
      coin!.behavior.selectQuad(cell, mapStore),
    )
  })
})
