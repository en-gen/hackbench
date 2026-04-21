import type { LevelSprite } from '../LevelParser'
import type { RomFile } from '../RomFile'
import { buildSpriteLayout, readSpriteTileTables } from '../SpriteTileLoader'
import type { Char } from './chars/Char'
import { makeTransparentPlaceholderChar } from './tiles/TileFactory'
import { Sprite } from './sprites/Sprite'
import { StaticSpriteAppearance, type SpritePart } from './sprites/appearances/StaticSpriteAppearance'
import type { SpriteAppearance } from './sprites/SpriteAppearance'
import type { SpriteBehavior } from './sprites/SpriteBehavior'

/**
 * Load sprites for a level and wrap them in the self-rendering model.
 *
 * Each LevelSprite (x, y in tile coords + spriteId) becomes a
 * `Sprite(id, px*16, py*16, appearance, behavior)`. Appearance is a
 * `StaticSpriteAppearance` assembled from the ROM's per-sprite-id
 * layout (SubSprGfx tables + the hand-extracted 0x54-0xC8 overrides).
 *
 * Sprites without a known layout fall back to a single-char anchor
 * marker so they still render *something* (matches the legacy fallback).
 * Sprites with no anchor char at all are skipped.
 */
export function buildSprites(
  rom: RomFile,
  levelSprites: readonly LevelSprite[],
  chars: Map<number, Char>,
): Sprite[] {
  const tables = readSpriteTileTables(rom)
  if (!tables) return []

  const placeholder = makeTransparentPlaceholderChar()
  const out: Sprite[] = []
  for (const s of levelSprites) {
    const layout = buildSpriteLayout(tables, s.spriteId)
    if (!layout) continue // no known layout — skip (legacy draws a red marker we don't)

    const parts: SpritePart[] = layout.tiles.map(t => ({
      char: chars.get(t.charNum) ?? placeholder,
      palette: t.palette,
      flipX: t.flipX,
      flipY: t.flipY,
      dx: t.dx,
      dy: t.dy,
    }))

    const appearance: SpriteAppearance = new StaticSpriteAppearance(parts)
    const behavior: SpriteBehavior = { kind: `sprite_${s.spriteId.toString(16)}` }
    out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, appearance, behavior))
  }
  return out
}

