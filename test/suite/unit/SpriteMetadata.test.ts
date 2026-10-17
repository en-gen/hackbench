import { describe, it, expect } from 'vitest'
import {
  SPRITE_METADATA,
  getSpriteMetadata,
  type SpriteMetadata,
} from '../../../src/rom/model/sprites/SpriteMetadata'
import { Sprite } from '../../../src/rom/model/sprites/Sprite'
import type { SpriteBehavior } from '../../../src/rom/model/sprites/SpriteBehavior'
import { StaticSpriteAppearance } from '../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import { serializeSprite } from '../../../src/rom/model/serialize'
import { buildSprite } from '../../../src/rom/model/rehydrate'
import type { Char } from '../../../src/rom/model/chars/Char'
import { makeTransparentPlaceholderChar } from '../../../src/rom/model/tiles/TileFactory'

describe('getSpriteMetadata', () => {
  it('returns Lakitu displayName without spawns/isGenerator', () => {
    const m = getSpriteMetadata(0x1e)
    expect(m?.displayName).toBe('Lakitu')
    expect(m?.spawns).toBeUndefined()
    expect(m?.isGenerator).toBeUndefined()
  })

  it('0xC9 is the Bullet Bill shooter, 0xCA the Torpedo Ted launcher (shooters, ShooterNumber = id - $C8)', () => {
    expect(getSpriteMetadata(0xc9)).toMatchObject({
      displayName: 'Bullet Bill Shooter',
      isGenerator: true,
      spawns: 0x1c,
    })
    expect(getSpriteMetadata(0xca)).toMatchObject({
      displayName: 'Torpedo Ted Launcher',
      isGenerator: true,
      spawns: 0x44,
    })
  })

  it('0xCE picks Para-Goomba or Para-Bomb at random, so it has no single spawn', () => {
    expect(getSpriteMetadata(0xce)?.spawns).toBeUndefined()
  })

  it('defines every id up to 0xFF', () => {
    for (let id = 0; id <= 0xff; id++) expect(getSpriteMetadata(id), `id ${id}`).toBeDefined()
  })

  it('returns display name for common sprite IDs', () => {
    expect(getSpriteMetadata(0x00)?.displayName).toBe('Green Koopa (no shell)')
    expect(getSpriteMetadata(0x0f)?.displayName).toBe('Goomba')
    expect(getSpriteMetadata(0x26)?.displayName).toBe('Thwomp')
  })

  it.each([
    [0xc9, 0x1c],
    [0xcb, 0x38],
    [0xcc, 0x3f],
    [0xcd, 0x40],
    [0xcf, 0x41],
    [0xd0, 0x41],
    [0xd1, 0x17],
    [0xd3, 0x71],
    [0xd4, 0x9d],
    [0xd5, 0x1c],
    [0xd6, 0x1c],
    [0xd7, 0x1c],
    [0xd8, 0xb3],
    [0xde, 0x39],
    [0xe0, 0xa3],
  ])('sprite 0x%s spawns 0x%s', (id, spawns) => {
    expect(getSpriteMetadata(id)?.spawns).toBe(spawns)
  })
})

// A table entry in 0xC9..0xFF is only as good as its citation (#985): the
// names there were wrong once because nothing tied them to the disassembly.
const SOURCE_RE = /^bank_0[0-9A-F]\.asm:\d+ \S+$/

function uncitedGeneratorIds(table: Record<number, SpriteMetadata>): number[] {
  const bad: number[] = []
  for (let id = 0xc9; id <= 0xff; id++) {
    const src = table[id]?.source
    if (src === undefined || !SOURCE_RE.test(src)) bad.push(id)
  }
  return bad
}

describe('0xC9..0xFF carry a SMWDisX citation', () => {
  it('checks 55 ids and finds none uncited', () => {
    expect(0xff - 0xc9 + 1).toBe(55)
    expect(uncitedGeneratorIds(SPRITE_METADATA)).toEqual([])
  })

  it('fails on a table with one source removed', () => {
    const planted = { ...SPRITE_METADATA, 0xd8: { ...SPRITE_METADATA[0xd8], source: undefined } }
    expect(uncitedGeneratorIds(planted)).toEqual([0xd8])
  })

  it('fails on a malformed source', () => {
    const planted = { ...SPRITE_METADATA, 0xe9: { ...SPRITE_METADATA[0xe9], source: 'bank_05' } }
    expect(uncitedGeneratorIds(planted)).toEqual([0xe9])
  })
})

describe('SpriteBehavior serialize/rehydrate round-trip', () => {
  const placeholder = makeTransparentPlaceholderChar()
  const chars = new Map<number, Char>()

  function roundTrip(behavior: SpriteBehavior) {
    const sprite = new Sprite(0xd3, 16, 32, new StaticSpriteAppearance([]), behavior)
    const desc = serializeSprite(sprite)
    const rehydrated = buildSprite(desc, chars, placeholder)
    return { desc, rehydrated }
  }

  it('preserves all metadata fields through serialize → rehydrate', () => {
    const { desc, rehydrated } = roundTrip({
      kind: 'sprite_d3',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
    expect(desc.behavior).toEqual({
      kind: 'sprite_d3',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
    expect(rehydrated.behavior).toEqual({
      kind: 'sprite_d3',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
  })

  it('omits optional keys from the descriptor when source behavior lacks them', () => {
    const { desc, rehydrated } = roundTrip({ kind: 'sprite_00' })
    expect(Object.keys(desc.behavior)).toEqual(['kind'])
    expect(rehydrated.behavior.kind).toBe('sprite_00')
    expect(rehydrated.behavior.displayName).toBeUndefined()
    expect(rehydrated.behavior.spawns).toBeUndefined()
    expect(rehydrated.behavior.isGenerator).toBeUndefined()
  })

  it('survives a JSON.parse(JSON.stringify) trip (postMessage safe)', () => {
    const sprite = new Sprite(0xc9, 0, 0, new StaticSpriteAppearance([]), {
      kind: 'sprite_c9',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
    const desc = serializeSprite(sprite)
    const wireFormat = JSON.parse(JSON.stringify(desc))
    const rehydrated = buildSprite(wireFormat, chars, placeholder)
    expect(rehydrated.behavior).toEqual({
      kind: 'sprite_c9',
      displayName: 'Bullet Bill Shooter',
      spawns: 0x1c,
      isGenerator: true,
    })
  })
})
