import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import type { SpriteAppearance, HitRect } from '../SpriteAppearance'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { SpriteBehavior } from '../SpriteBehavior'
import type { Char } from '../../chars/Char'
import type { SpriteTileTables } from '../../../SpriteTileLoader'
import { isActsLikeHorizSolid, isActsLikeVertSolid } from '../../OverlayContext'
import type { GetL1Tile, L1Cell, OverlayContext } from '../../OverlayContext'
import { COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH, drawArrowHead, rgba } from '../../overlays/primitives'

const OBJ_BASE      = 0x400
const CORNER_OFFSETS = [0x00, 0x01, 0x10, 0x11] as const
// EffFrame >> 3 & 1 — toggles every 8 game frames (bank_02.asm:8079-8083)
const ANIM_TICKS = 8

/**
 * 8-direction wall-following tables.
 *
 * Source: DATA_02BC8F/BC97 (forward speeds), DATA_02BC9F/BCA7 (probe speeds).
 * Dirs 0–3: right-hand rule track (wall to the sprite's right).
 *   0=RIGHT(wall below), 1=DOWN(wall left), 2=LEFT(wall above), 3=UP(wall right)
 * Dirs 4–7: left-hand rule track (wall to the sprite's left).
 *   4=LEFT(wall below), 5=DOWN(wall right), 6=RIGHT(wall above), 7=UP(wall left)
 *
 * InitSpikeTop (bank_01.asm:602) → CODE_01840E (bank_01.asm:620):
 *   Mario to the LEFT of sprite → SpriteTableC2 = 4 (LEFT, left-hand rule)
 *   Mario to the RIGHT          → SpriteTableC2 = 0 (RIGHT, right-hand rule)
 */
const FWD_COL   = [ 1,  0, -1,  0, -1,  0,  1,  0] as const
const FWD_ROW   = [ 0,  1,  0, -1,  0,  1,  0, -1] as const
const PROBE_COL = [ 1, -1, -1,  1, -1,  1,  1, -1] as const
const PROBE_ROW = [ 1,  1, -1, -1,  1,  1, -1, -1] as const

const MAX_PATH_STEPS = 400

function solidForWallFollow(cell: L1Cell | null): boolean {
  if (!cell) return false
  if (cell.isPriority) return false
  // Use pre-computed ROM-port collision flags when available (covers page-0 tiles
  // that isActsLikeHorizSolid excludes — e.g. cave/fortress wall tile IDs).
  if (cell.collision !== undefined) {
    return cell.collision.wall || cell.collision.floor || cell.collision.ceiling
  }
  // Fallback for test fixtures built without a classification pass.
  return isActsLikeHorizSolid(cell.actsLike) || isActsLikeVertSolid(cell.actsLike)
}

/**
 * Simulate the Spike Top wall-following algorithm in tile space.
 * Source: bank_02.asm:8065–8091 — WallFollowersMain.
 *
 * Supports both 8-direction tracks:
 *   Dirs 0–3: right-hand rule (InitSpikeTop → Mario to the right → dir=0)
 *   Dirs 4–7: left-hand rule  (InitSpikeTop → Mario to the left  → dir=4)
 *
 * Per step:
 *   probe = tile at (col + PROBE_COL[dir], row + PROBE_ROW[dir])
 *   if probe NOT solid → outer corner: advance + rotate within same track (dir+1 & 7, track-bit preserved)
 *   else if forward IS solid → inner corner: turn within track (dir+3 & 7, track-bit preserved)
 *   else → advance, same direction
 *
 * @param levelCols  Column count of the level; path terminates at boundary (sprite despawn).
 * @param levelRows  Row count of the level; path terminates at boundary.
 *
 * Returns visited tile positions and whether the loop closed. Stops at maxSteps
 * when the Spike Top is in an open/unbounded region.
 */
export function tracePatrolPath(
  startCol: number,
  startRow: number,
  startDir: number,
  getL1: GetL1Tile,
  maxSteps = MAX_PATH_STEPS,
  levelCols = 9999,
  levelRows = 9999,
): { points: readonly { col: number; row: number }[]; closed: boolean } {
  const points: { col: number; row: number }[] = []
  let col = startCol, row = startRow, dir = startDir

  for (let step = 0; step < maxSteps; step++) {
    points.push({ col, row })

    const probeEmpty = !solidForWallFollow(getL1(col + PROBE_COL[dir], row + PROBE_ROW[dir]))
    const fwdSolid   =  solidForWallFollow(getL1(col + FWD_COL[dir],   row + FWD_ROW[dir]))

    if (probeEmpty) {
      // Outer corner: advance forward, then rotate within same track (clockwise in screen space).
      // Track bit (bit 2) is preserved; rotation is within the 4-dir sub-group.
      col += FWD_COL[dir]
      row += FWD_ROW[dir]
      dir  = (dir & 4) | ((dir + 1) & 3)
    } else if (fwdSolid) {
      // Inner corner: rotate opposite direction within same track.
      dir = (dir & 4) | ((dir + 3) & 3)
    } else {
      // Normal step: advance, keep direction.
      col += FWD_COL[dir]
      row += FWD_ROW[dir]
    }

    // Sprite despawns when it leaves the level boundary.
    if (col < 0 || col >= levelCols || row < 0 || row >= levelRows) {
      return { points, closed: false }
    }

    if (col === startCol && row === startRow && dir === startDir) {
      return { points, closed: true }
    }
  }

  return { points, closed: false }
}

export class SpikeTopAppearance implements SpriteAppearance {
  readonly hitRect: HitRect
  private tick  = 0
  private frame = 0

  constructor(
    readonly parts0: readonly SpritePart[],
    readonly parts1: readonly SpritePart[],
  ) {
    this.hitRect = partsHitRect(parts0)
  }

  /**
   * Build both animation frames from the ROM tile tables.
   *
   * Direction defaults to 0 (DATA_02BCC7[0]=$00 → no flip).
   * Frame 0: SprTilemap[tilemapBase + 0], Frame 1: SprTilemap[tilemapBase + 1].
   * Both frames expand to four 8×8 corners via the SNES large-OBJ layout
   * [N, N+1, N+$10, N+$11] (bank_01.asm:4148 SubSprGfx2Entry1).
   */
  static fromTables(chars: Map<number, Char>, tables: SpriteTileTables, placeholder: Char): SpikeTopAppearance {
    const attr        = tables.spriteAttr[0x2E] ?? 0
    const palette     = 8 + ((attr >> 1) & 0x07)
    const charHigh    = (attr & 0x01) !== 0 ? 0x100 : 0
    const tilemapBase = tables.tilemapOffset[0x2E] ?? 0

    const makeParts = (animOffset: number): SpritePart[] =>
      CORNER_OFFSETS.map((co, corner) => {
        const baseTile = tables.tilemap[tilemapBase + animOffset] ?? 0
        return {
          char:  chars.get(OBJ_BASE + charHigh + ((baseTile + co) & 0x1FF)) ?? placeholder,
          palette,
          flipX: false,
          flipY: false,
          dx:    tables.dispX[corner] ?? 0,
          dy:    tables.dispY[corner] ?? 0,
        }
      })

    return new SpikeTopAppearance(makeParts(0), makeParts(1))
  }

  tickAnimation(): void {
    if (++this.tick >= ANIM_TICKS) { this.tick = 0; this.frame ^= 1 }
  }

  render(ctx: RenderContext, target: RenderTarget, x: number, y: number, _behavior: SpriteBehavior): void {
    for (const p of (this.frame === 0 ? this.parts0 : this.parts1)) {
      target.blit8x8(
        p.char.getPixels(ctx),
        { x: x + p.dx, y: y + p.dy },
        ctx.palette.row(p.palette, ctx),
        p.flipX,
        p.flipY,
      )
    }
  }

  renderOverlay(
    ctx:          OverlayContext,
    x:            number,
    y:            number,
    isActive:     boolean,
    getL1:        GetL1Tile,
    levelCols:    number,
    levelRows:    number,
    _behavior?:   SpriteBehavior,
    marioSpawnX?: number,
  ): void {
    if (!isActive) return

    const startCol = Math.floor(x / 16)
    const startRow = Math.floor(y / 16)

    // InitSpikeTop (bank_01.asm:602) → CODE_01840E (bank_01.asm:620-626):
    //   SubHorizPos: Mario.X < Sprite.X (Mario to left) → SpriteTableC2 = 4 (dir 4=LEFT, left-hand track)
    //   Mario.X ≥ Sprite.X (Mario to right or same)    → SpriteTableC2 = 0 (dir 0=RIGHT, right-hand track)
    const startDir = (marioSpawnX !== undefined && marioSpawnX < x) ? 4 : 0

    const { points, closed } = tracePatrolPath(startCol, startRow, startDir, getL1, MAX_PATH_STEPS, levelCols, levelRows)
    if (points.length < 2) return

    const color = COLORS.patrolPath
    const toPixel = (p: { col: number; row: number }) => ({ x: p.col * 16 + 8, y: p.row * 16 + 8 })

    ctx.save()

    // Dashed patrol polyline.
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.beginPath()
    const first = toPixel(points[0])
    ctx.moveTo(first.x, first.y)
    for (let i = 1; i < points.length; i++) {
      const p = toPixel(points[i])
      ctx.lineTo(p.x, p.y)
    }
    if (closed) ctx.closePath()
    ctx.stroke()
    ctx.setLineDash([])

    // Direction arrows every ~quarter of the path length.
    const interval = Math.max(1, Math.floor(points.length / 4))
    for (let i = interval; i < points.length; i += interval) {
      const from = toPixel(points[i - 1])
      const tip  = toPixel(points[i])
      drawArrowHead(ctx, tip.x, tip.y, from.x, from.y, color, DASH_ALPHA)
    }

    ctx.restore()
  }
}
