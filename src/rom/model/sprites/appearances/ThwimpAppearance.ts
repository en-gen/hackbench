import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import type { Char } from '../../chars/Char'
import type { SpriteTileTables } from '../../../SpriteTileLoader'
import { solidityFromL1 } from '../MovementBehavior'
import type { SpriteBehavior } from '../SpriteBehavior'
import { ThwimpBounceBehavior } from '../behaviors/ThwimpBounceBehavior'
import {
  COLORS,
  DASH_ALPHA,
  DASH_LINE_WIDTH,
  DEFAULT_DASH,
  drawSpawnDrop,
  rgba,
} from '../../overlays/primitives'
import {
  StaticSpriteAppearance,
  type SpritePart,
} from './StaticSpriteAppearance'

/**
 * Sprite $27 — Thwimp.
 *
 * ROM draw path: `LDA #$01 : JMP SubSprGfx0Entry0` (bank_01.asm:6517-6519).
 *
 * SubSprGfx0Entry0 with _5=1 reads four independent 8×8 tile bytes from
 * SprTilemap[SprTilemapOffset[$27] + corner] ($8A..$8D) and applies
 * GeneralSprGfxProp[_5*4 + corner] = $00,$40,$00,$40 as OAM attribute bits:
 *   bit 6 set → H-flip.  Right column (corners 1 TR and 3 BR) is H-flipped.
 *
 * Init: Return01AEA2 (bank_01.asm:6323) — RTS only, no anchor shift.
 * Contrast with InitThwomp which does SpriteXPosLow += 8 before drawing.
 *
 * Layout (GeneralSprDispX/Y = [0,8,0,8] / [0,0,8,8]):
 *   TL (0,0) = SprTilemap[$8A] = $67   no flip
 *   TR (8,0) = SprTilemap[$8B] = $69   H-flip
 *   BL (0,8) = SprTilemap[$8C] = $88   no flip
 *   BR (8,8) = SprTilemap[$8D] = $CE   H-flip
 */
export class ThwimpAppearance extends StaticSpriteAppearance {
  static fromTables(
    chars: Map<number, Char>,
    tables: SpriteTileTables,
    placeholder: Char,
  ): ThwimpAppearance {
    const OBJ_CHAR_BASE = 0x400
    const attr     = tables.spriteAttr[0x27] ?? 0
    const palette  = 8 + ((attr >> 1) & 0x07)
    const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
    const base     = tables.tilemapOffset[0x27] ?? 0

    // Corners 0=TL, 1=TR, 2=BL, 3=BR. Right column (1, 3) gets H-flip from
    // GeneralSprGfxProp[1*4 + corner] = $00,$40,$00,$40 (bit 6 = H-flip).
    const FLIP_X = [false, true, false, true] as const
    const DX     = [0, 8, 0, 8]             as const
    const DY     = [0, 0, 8, 8]             as const

    const parts: SpritePart[] = [0, 1, 2, 3].map(corner => {
      const tileByte = tables.tilemap[base + corner] ?? 0
      return {
        char:   chars.get(OBJ_CHAR_BASE + charHigh + (tileByte & 0x1FF)) ?? placeholder,
        palette,
        flipX:  FLIP_X[corner],
        flipY:  false,
        dx:     DX[corner],
        dy:     DY[corner],
      }
    })
    return new ThwimpAppearance(parts)
  }

  renderOverlay(
    ctx:       OverlayContext,
    x:         number,
    y:         number,
    isActive:  boolean,
    getL1:     GetL1Tile,
    levelCols: number,
    levelRows: number,
    behavior?: SpriteBehavior,
  ): void {
    if (!isActive || !(behavior instanceof ThwimpBounceBehavior)) return
    const { solidV } = solidityFromL1(getL1)
    const path = behavior.computeBouncePath(x, y, solidV, levelCols, levelRows)
    if (path.length < 2) return

    const color       = COLORS.patrolPath
    const centerX     = x + 8
    const spawnBottom = y + 16

    // Spawn drop: sprite placed mid-air falls to the resting row first.
    // path[0].y is body-bottom at the resting ground level.
    if (spawnBottom < path[0].y - 1) {
      drawSpawnDrop(ctx, centerX, spawnBottom, path[0].y, color)
    }

    // First-hop arc — dashed polyline only, no envelope.
    ctx.save()
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()
    ctx.moveTo(path[0].x, path[0].y)
    for (let i = 1; i < path.length; i++) ctx.lineTo(path[i].x, path[i].y)
    ctx.stroke()
    ctx.setLineDash([])
    ctx.restore()
  }
}
