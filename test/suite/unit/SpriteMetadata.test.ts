import { describe, it, expect } from 'vitest'
import { getSpriteMetadata } from '../../../src/rom/model/sprites/SpriteMetadata'
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

  it('flags 0xC9 Eerie Generator as generator with spawns 0x38', () => {
    const m = getSpriteMetadata(0xc9)
    expect(m).toEqual({ displayName: 'Eerie Generator', isGenerator: true, spawns: 0x38 })
  })

  it('flags 0xCA Para-Enemy Generator as generator with no concrete spawn', () => {
    const m = getSpriteMetadata(0xca)
    expect(m?.isGenerator).toBe(true)
    expect(m?.spawns).toBeUndefined()
  })

  it('returns undefined for IDs beyond the defined range', () => {
    expect(getSpriteMetadata(0xe8)).toBeUndefined()
    expect(getSpriteMetadata(0xff)).toBeUndefined()
    expect(getSpriteMetadata(0xf0)).toBeUndefined()
  })

  it('returns display name for common sprite IDs', () => {
    expect(getSpriteMetadata(0x00)?.displayName).toBe('Green Koopa (no shell)')
    expect(getSpriteMetadata(0x0f)?.displayName).toBe('Goomba')
    expect(getSpriteMetadata(0x26)?.displayName).toBe('Thwomp')
  })

  it.each([
    [0xc9, 0x38],
    [0xd3, 0x1c],
    [0xd4, 0x41],
  ])('sprite 0x%s spawns 0x%s', (id, spawns) => {
    expect(getSpriteMetadata(id)?.spawns).toBe(spawns)
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
      displayName: 'Eerie Generator',
      spawns: 0x38,
      isGenerator: true,
    })
    const desc = serializeSprite(sprite)
    const wireFormat = JSON.parse(JSON.stringify(desc))
    const rehydrated = buildSprite(wireFormat, chars, placeholder)
    expect(rehydrated.behavior).toEqual({
      kind: 'sprite_c9',
      displayName: 'Eerie Generator',
      spawns: 0x38,
      isGenerator: true,
    })
  })
})
