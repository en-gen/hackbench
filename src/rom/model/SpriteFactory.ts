import type { LevelSprite } from '../LevelParser'
import type { RomFile } from '../RomFile'
import { buildSpriteLayout, readSpriteTileTables } from '../SpriteTileLoader'
import type { Char } from './chars/Char'
import { makeTransparentPlaceholderChar } from './tiles/TileFactory'
import { Sprite } from './sprites/Sprite'
import { StaticSpriteAppearance, type SpritePart } from './sprites/appearances/StaticSpriteAppearance'
import { PSwitchAppearance } from './sprites/appearances/PSwitchAppearance'
import { ThwompAppearance } from './sprites/appearances/ThwompAppearance'
import { WingedBlockAppearance } from './sprites/appearances/WingedBlockAppearance'
import type { SpriteAppearance } from './sprites/SpriteAppearance'
import type { SpriteBehavior } from './sprites/SpriteBehavior'
import { getSpriteMetadata } from './sprites/SpriteMetadata'

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
  l1: readonly (number | null)[][],
): Sprite[] {
  const tables = readSpriteTileTables(rom)
  if (!tables) return []

  const placeholder = makeTransparentPlaceholderChar()
  const out: Sprite[] = []
  for (const s of levelSprites) {
    const behavior: SpriteBehavior = {
      kind: `sprite_${s.spriteId.toString(16)}`,
      ...getSpriteMetadata(s.spriteId),
    }

    // Sprite $26 (Thwomp) has a custom ROM draw routine (ThwompGfx, not
    // SubSprGfx2): 4 body big-tiles at x+4/x+12 relative to the
    // InitThwomp-shifted anchor plus a cursor-selected face tile. The
    // generic layout would place it as a single 16×16 big-tile in the
    // wrong spot, so dispatch to the dedicated appearance.
    if (s.spriteId === 0x26) {
      const attr     = tables.spriteAttr[s.spriteId] ?? 0
      const palette  = 8 + ((attr >> 1) & 0x07)
      const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
      const px       = s.x * 16
      const py       = s.y * 16
      const thwompBehavior: SpriteBehavior = {
        ...behavior,
        reactRangeDy: thwompReactRangeDy(l1, px, py),
      }
      out.push(new Sprite(
        s.spriteId, px, py,
        ThwompAppearance.fromTables(chars, palette, charHigh, placeholder),
        thwompBehavior,
      ))
      continue
    }

    // Sprites $83/$84 (Left/Right Flying Question Block) draw a 16×16 ? block
    // body plus two animated 8×8 wing tiles driven by ctx.animFrame, matching
    // the in-game KoopaWingGfxRt/CODE_019E95 routine (bank_01.asm:4024/4083).
    if (s.spriteId === 0x83 || s.spriteId === 0x84) {
      const layout = buildSpriteLayout(tables, s.spriteId)
      const bodyParts: SpritePart[] = (layout?.tiles ?? []).map(t => ({
        char: chars.get(t.charNum) ?? placeholder,
        palette: t.palette, flipX: t.flipX, flipY: t.flipY, dx: t.dx, dy: t.dy,
      }))
      const WING_PAL = 11
      const BASE = 0x400
      const c = (n: number) => chars.get(BASE + n) ?? placeholder
      const p = (n: number, dx: number, dy: number, flipX: boolean): SpritePart =>
        ({ char: c(n), palette: WING_PAL, flipX, flipY: false, dx, dy })
      // Frame 0: one 8×8 tile per wing (OAM size $00)
      const wf0: SpritePart[] = [
        p(0x5D,  -3, -2, true),   // left
        p(0x5D,  11, -2, false),  // right
      ]
      // Frame 1: 16×16 OAM tile per wing (size $02) = 2×2 block of 8×8 chars.
      // Left wing has flipX set → SNES swaps columns and flips each tile.
      // Sibling chars: $C6→TL, $C7→TR, $D6→BL, $D7→BR (VRAM layout: +1 right, +$10 down)
      const wf1: SpritePart[] = [
        p(0xC7, -11, -10, true),  p(0xC6,  -3, -10, true),   // left wing top row
        p(0xD7, -11,  -2, true),  p(0xD6,  -3,  -2, true),   // left wing bottom row
        p(0xC6,  11, -10, false), p(0xC7,  19, -10, false),  // right wing top row
        p(0xD6,  11,  -2, false), p(0xD7,  19,  -2, false),  // right wing bottom row
      ]
      out.push(new Sprite(
        s.spriteId, s.x * 16, s.y * 16,
        new WingedBlockAppearance(bodyParts, [wf0, wf1]),
        behavior,
      ))
      continue
    }

    const layout = buildSpriteLayout(tables, s.spriteId)
    if (!layout) {
      const boxChar = chars.get(-2) ?? makeTransparentPlaceholderChar()
      const palette = 8 + ((tables.spriteAttr[s.spriteId] ?? 0) >> 1 & 0x07)
      const boxParts: SpritePart[] = [
        { char: boxChar, palette, flipX: false, flipY: false, dx: 0, dy: 0 },
        { char: boxChar, palette, flipX: true,  flipY: false, dx: 8, dy: 0 },
        { char: boxChar, palette, flipX: false, flipY: true,  dx: 0, dy: 8 },
        { char: boxChar, palette, flipX: true,  flipY: true,  dx: 8, dy: 8 },
      ]
      out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, new StaticSpriteAppearance(boxParts), behavior))
      continue
    }

    const parts: SpritePart[] = layout.tiles.map(t => ({
      char: chars.get(t.charNum) ?? placeholder,
      palette: t.palette,
      flipX: t.flipX,
      flipY: t.flipY,
      dx: t.dx,
      dy: t.dy,
    }))

    const appearance: SpriteAppearance = s.spriteId === 0x3E
      ? new PSwitchAppearance(parts)
      : new StaticSpriteAppearance(parts)
    out.push(new Sprite(s.spriteId, s.x * 16, s.y * 16, appearance, behavior))
  }
  return out
}

/**
 * Pixel distance from `py` (top of thwomp body) down through the bottom of
 * the first solid L1 row below the body — i.e. where the thwomp would stop
 * falling. Any non-null tile counts as a blocker (matches the fall-path
 * overlay in drawThwompZones). Falls back to the level floor when nothing
 * blocks. The appearance uses this to gate face-tile reactivity by cursor Y.
 */
function thwompReactRangeDy(
  l1: readonly (number | null)[][],
  px: number,
  py: number,
): number {
  const rows     = l1.length
  const colStart = Math.floor((px + 4) / 16)
  const colEnd   = Math.ceil((px + 28) / 16)
  const startRow = Math.ceil((py + 32) / 16)
  let blockerRow = rows
  outer: for (let r = startRow; r < rows; r++) {
    for (let c = colStart; c < colEnd; c++) {
      if ((l1[r]?.[c] ?? null) !== null) { blockerRow = r; break outer }
    }
  }
  const zoneBottom = blockerRow < rows ? (blockerRow + 1) * 16 : rows * 16
  return zoneBottom - py
}

