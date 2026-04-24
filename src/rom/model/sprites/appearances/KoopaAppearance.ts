import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import { COLORS, drawCorridor, drawFallL, drawSpawnDrop } from '../../overlays/primitives'
import { KoopaWalkBehavior } from '../behaviors/KoopaWalkBehavior'
import { solidityFromL1 } from '../MovementBehavior'
import type { SpriteBehavior } from '../SpriteBehavior'
import { StaticSpriteAppearance, type SpritePart } from './StaticSpriteAppearance'

/**
 * Ground-walking koopa appearance — $04 Green / $05 Red / $06 Blue /
 * $07 Yellow (and future Spr0to13Main family: $0F Goomba, $11 Buzzy
 * Beetle, $13 Spiny).
 *
 * Renders the sprite's pixel parts via `StaticSpriteAppearance` and adds
 * an overlay that shows the walk corridor. The corridor comes from the
 * attached `KoopaWalkBehavior.computePatrolRange` — walls in body rows
 * and (for ledge-turners $05/$06) missing floors bound the patrol
 * region.
 *
 * Walls render as solid boundary lines. Non-turning koopas ($04/$07/$0C)
 * that actually reach a fallLedge (factoring in initial-LEFT direction
 * and wall bounces) get an L-shaped "falls off here" indicator on that
 * side — horizontal band extending past the ledge, then a vertical band
 * dropping down. Only one L ever appears; the first obstacle the koopa
 * reaches settles the outcome.
 */
export class KoopaAppearance extends StaticSpriteAppearance {
  constructor(parts: SpritePart[]) {
    super(parts)
  }

  override renderOverlay(
    ctx:       OverlayContext,
    x:         number,
    y:         number,
    isActive:  boolean,
    getL1:     GetL1Tile,
    levelCols: number,
    levelRows: number,
    behavior?: SpriteBehavior,
  ): void {
    if (!isActive || !(behavior instanceof KoopaWalkBehavior)) return
    const { solidH, solidV, hasGround } = solidityFromL1(getL1)
    const r = behavior.computePatrolRange(x, y, solidH, solidV, levelCols, levelRows, hasGround)
    // Diagnostic — write raw scan inputs to `window.__koopaDebug` so the
    // user can inspect tile id / actsLike / collision at each scanned
    // column in devtools. Strip once the classifier is trusted.
    const sprCol = Math.floor(x / 16)
    const rowBot = Math.floor(y / 16)
    const floorRowSpawn = rowBot + 1
    const sample = (c: number, rr: number): unknown => {
      const cell = getL1(c, rr)
      return cell === null ? null : {
        id: `$${cell.id.toString(16).padStart(3, '0')}`,
        actsLike: `$${cell.actsLike.toString(16).padStart(3, '0')}`,
        isPriority: cell.isPriority,
        collision: cell.collision,
      }
    }
    const floorCols: Record<string, unknown> = {}
    for (let dc = -8; dc <= 2; dc++) {
      const c = sprCol + dc
      floorCols[`${c}`] = {
        floorRow:     sample(c, floorRowSpawn),
        floorRowPlus: sample(c, floorRowSpawn + 1),
        bodyTop:      sample(c, rowBot - 1),
        bodyBot:      sample(c, rowBot),
      }
    }
    ;(globalThis as { __koopaDebug?: unknown }).__koopaDebug = {
      spr: { x, y, col: sprCol, rowBot, floorRowSpawn },
      result: {
        leftX: r.leftX,      rightX: r.rightX,
        leftKind: r.leftKind, rightKind: r.rightKind,
        fallSide: r.fallSide,
        spawnDropFromY: r.spawnDropFromY,
        bottomY: r.bottomY,
      },
      cols: floorCols,
    }
    // Hard boundary line whenever the koopa would TURN AROUND on that
    // side — a wall, or a turnLedge (ledge for `turnsAtLedges=true`
    // koopas like $05/$06 where they flip direction instead of falling).
    // Dashed otherwise (level edges, or the non-scanned right side).
    const solidLeft  = r.leftKind  === 'wall' || r.leftKind  === 'turnLedge'
    const solidRight = r.rightKind === 'wall' || r.rightKind === 'turnLedge'
    ctx.save()
    drawCorridor(
      ctx,
      r.leftX, r.rightX, r.topY, r.bottomY,
      COLORS.greenGround,
      { solidLeft, solidRight },
    )
    if (r.fallSide === 'left') {
      drawFallL(ctx, r.leftX,  r.topY, r.bottomY, -1, COLORS.greenGround)
    } else if (r.fallSide === 'right') {
      drawFallL(ctx, r.rightX, r.topY, r.bottomY, +1, COLORS.greenGround)
    }
    // Sprite spawns airborne — dotted line from spawn to patrol row.
    if (r.spawnDropFromY !== undefined) {
      drawSpawnDrop(ctx, x + 8, r.spawnDropFromY, r.bottomY, COLORS.greenGround)
    }
    ctx.restore()
  }
}
