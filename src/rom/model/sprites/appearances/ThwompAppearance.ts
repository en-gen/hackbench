import type { Char } from '../../chars/Char'
import { isActsLikeVertSolid, type GetL1Tile, type OverlayContext } from '../../OverlayContext'
import type { RenderContext, RenderTarget } from '../../RenderTarget'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'

/**
 * Sprite $26 — Thwomp. Self-rendering appearance that mirrors ThwompGfx
 * (`bank_01.asm:6422`) exactly for geometry and picks the center face tile
 * from cursor proximity, standing in for Mario in the editor.
 *
 * ROM geometry (why the numbers below are what they are):
 *   InitThwomp (`bank_01.asm:6316`) does `SpriteXPosLow += 8` at spawn.
 *   Thereafter ThwompDispX `db $FC,$04,$FC,$04,$00` (-4, +4, -4, +4, 0)
 *   and ThwompDispY `db $00,$00,$10,$10,$08` offset each OAM entry from
 *   that shifted anchor. Combined with the +8 shift, the body columns
 *   end up at x+4 (left) and x+12 (right) relative to the original
 *   pre-InitThwomp sprite.x, and the face sits at x+8, y+8.
 *
 * Body tiles ThwompTiles `db $8E,$8E,$AE,$AE` — $8E top, $AE bottom.
 * Right column is rendered with ThwompGfxProp `$43` (H-flip) while the
 * left uses `$03` (no flip). The low bit of both — the name-table bit —
 * picks OBJ VRAM page 1, i.e. charHigh = $100 (sp3/sp4). Both body and
 * face tiles therefore live in sp4 (chars $580-$5FF).
 *
 * Face tile ThwompTiles[4] = $C8 by default; when SpriteMisc1528=2
 * (within ±36 px of Mario) ThwompGfx swaps in $CA. SpriteMisc1528=1
 * (within ±64 px) keeps $C8 but marks the state. In-game ThwompGfxProp
 * is hardcoded `db $03,$43,$03,$43,$03` so the body never mirrors at
 * runtime — the face-tile swap is the only directional cue, and we match
 * that exactly.
 */

const OBJ_CHAR_BASE  = 0x400
const CORNER_OFFSET  = [0x00, 0x01, 0x10, 0x11] as const
const FLIP_CORNER    = [0x01, 0x00, 0x11, 0x10] as const
const SUB_DX         = [0, 8, 0, 8] as const
const SUB_DY         = [0, 0, 8, 8] as const

/** Detection range in pixels from the InitThwomp-shifted anchor. */
const ALERT_PX       = 64
const AGGRESSIVE_PX  = 36

const ANCHOR_DX      = 8   // InitThwomp +8 X shift

/**
 * Expand one 16×16 SNES OAM big-tile into four 8×8 SpriteParts.
 *
 * The hardware's large-size bit makes tile N occupy [N, N+1, N+$10, N+$11]
 * for TL/TR/BL/BR. When H-flipped the L/R subtiles swap so the visual
 * mirror is correct; each subtile is also drawn flipped.
 */
function bigTileParts(
  chars: Map<number, Char>,
  baseTile: number,
  baseDx: number,
  baseDy: number,
  hFlip: boolean,
  palette: number,
  charHigh: number,
  placeholder: Char,
): SpritePart[] {
  const offsets = hFlip ? FLIP_CORNER : CORNER_OFFSET
  return [0, 1, 2, 3].map(c => ({
    char: chars.get(OBJ_CHAR_BASE + charHigh + ((baseTile + offsets[c]) & 0x1FF)) ?? placeholder,
    palette,
    flipX: hFlip,
    flipY: false,
    dx: baseDx + SUB_DX[c],
    dy: baseDy + SUB_DY[c],
  }))
}

export class ThwompAppearance implements SpriteAppearance {
  readonly hitRect: HitRect

  constructor(
    readonly bodyParts:      readonly SpritePart[],
    readonly alertFace:      readonly SpritePart[],
    readonly aggressiveFace: readonly SpritePart[],
  ) {
    this.hitRect = partsHitRect([...bodyParts, ...alertFace])
  }

  /**
   * Build from raw ROM tables — used by `SpriteFactory` on the extension
   * host. The rehydrator on the webview side reconstructs directly via the
   * constructor after deserializing the three parts arrays. The vertical
   * reach that gates face reactivity is a behavioral property and lives on
   * the SpriteBehavior, not here.
   */
  static fromTables(
    chars: Map<number, Char>,
    palette: number,
    charHigh: number,
    placeholder: Char,
  ): ThwompAppearance {
    // Four body OAM entries: left-top, right-top, left-bottom, right-bottom.
    // Right-column entries are H-flipped (ThwompGfxProp bit 6).
    const bodyEntries: readonly [number, number, number, boolean][] = [
      [0x8E,  4,  0, false],
      [0x8E, 12,  0, true ],
      [0xAE,  4, 16, false],
      [0xAE, 12, 16, true ],
    ]
    const bodyParts = bodyEntries.flatMap(([tile, dx, dy, flip]) =>
      bigTileParts(chars, tile, dx, dy, flip, palette, charHigh, placeholder))
    // Face OAM entry — single 16×16 big-tile centered on the anchor, never
    // H-flipped in-game. Alert vs aggressive is a tile-number swap.
    const alertFace      = bigTileParts(chars, 0xC8, 8, 8, false, palette, charHigh, placeholder)
    const aggressiveFace = bigTileParts(chars, 0xCA, 8, 8, false, palette, charHigh, placeholder)
    return new ThwompAppearance(bodyParts, alertFace, aggressiveFace)
  }

  render(
    ctx: RenderContext,
    target: RenderTarget,
    x: number,
    y: number,
    behavior: SpriteBehavior,
  ): void {
    // Reading `.value` here is what wires cursor moves into this sprite's
    // reactive re-render. The toplevel renderModelOverlay also reads
    // ctx.cursorPx to register the dep unconditionally.
    const cursor  = ctx.cursorPx?.value ?? null
    const anchorX = x + ANCHOR_DX
    const hdist   = cursor ? Math.abs(cursor.x - anchorX) : Infinity
    // Cursor must also fall within the thwomp's vertical reach — top of body
    // down through the bottom of the first blocker row, precomputed on the
    // behavior by SpriteFactory. Outside that band the face stays idle
    // regardless of horizontal distance. When the behavior has no reach
    // (unexpected but defensive), treat as unbounded vertically.
    const reach     = behavior.reactRangeDy ?? Infinity
    const inYRange  = cursor !== null && cursor.y >= y && cursor.y < y + reach
    const face      = inYRange && hdist <= AGGRESSIVE_PX ? this.aggressiveFace
                    : inYRange && hdist <= ALERT_PX      ? this.alertFace
                    : null

    for (const part of this.bodyParts) this.blitPart(ctx, target, x, y, part)
    if (face) for (const part of face) this.blitPart(ctx, target, x, y, part)
  }

  renderOverlay(
    ctx:       OverlayContext,
    x:         number,
    y:         number,
    isActive:  boolean,
    getL1:     GetL1Tile,
    _levelCols: number,
    levelRows: number,
  ): void {
    if (!isActive) return
    // Anchor shifted by InitThwomp's +8 X adjustment.
    const anchorX = x + ANCHOR_DX

    // Walk down from below the body to find the first solid L1 blocker row.
    const colStart  = Math.floor((x + 4)  / 16)
    const colEnd    = Math.ceil ((x + 28) / 16)
    const startRow  = Math.ceil ((y + 32) / 16)
    let   blockerRow = levelRows
    outer: for (let r = startRow; r < levelRows; r++) {
      for (let c = colStart; c < colEnd; c++) {
        const cell = getL1(c, r)
        if (cell !== null && !cell.isPriority && isActsLikeVertSolid(cell.actsLike)) { blockerRow = r; break outer }
      }
    }

    const zoneTop    = y
    const zoneBottom = blockerRow < levelRows ? (blockerRow + 1) * 16 : levelRows * 16
    const zoneH      = zoneBottom - zoneTop
    const bodyL      = x + 4
    const bodyR      = x + 28

    ctx.save()

    // Alert zone ±64 px — amber columns flanking the body.
    const alertFarL = anchorX - 64
    const alertFarR = anchorX + 64
    ctx.fillStyle = 'rgba(255,160,0,0.15)'
    ctx.fillRect(alertFarL, zoneTop, bodyL - alertFarL, zoneH)
    ctx.fillRect(bodyR,     zoneTop, alertFarR - bodyR, zoneH)
    ctx.lineWidth = 1
    ctx.setLineDash([4, 3])
    ctx.strokeStyle = 'rgba(255,160,0,0.50)'
    ctx.strokeRect(alertFarL + 0.5, zoneTop + 0.5, bodyL - alertFarL - 1, zoneH - 1)
    ctx.strokeRect(bodyR     + 0.5, zoneTop + 0.5, alertFarR - bodyR - 1, zoneH - 1)

    // Aggressive zone ±36 px — brighter orange.
    const aggFarL = anchorX - 36
    const aggFarR = anchorX + 36
    ctx.fillStyle = 'rgba(255,100,0,0.20)'
    ctx.fillRect(aggFarL, zoneTop, bodyL - aggFarL, zoneH)
    ctx.fillRect(bodyR,   zoneTop, aggFarR - bodyR, zoneH)
    ctx.setLineDash([2, 2])
    ctx.strokeStyle = 'rgba(255,100,0,0.75)'
    ctx.strokeRect(aggFarL + 0.5, zoneTop + 0.5, bodyL - aggFarL - 1, zoneH - 1)
    ctx.strokeRect(bodyR   + 0.5, zoneTop + 0.5, aggFarR - bodyR - 1, zoneH - 1)

    // Fall path — red column from below body to blocker.
    ctx.setLineDash([])
    ctx.fillStyle = 'rgba(240,60,60,0.30)'
    ctx.fillRect(x + 4, startRow * 16, 24, (blockerRow - startRow) * 16)
    if (blockerRow < levelRows) {
      ctx.lineWidth = 2
      ctx.strokeStyle = 'rgba(240,60,60,0.85)'
      ctx.strokeRect(x + 4 + 1, blockerRow * 16 + 1, 22, 14)
    }

    // Body outline — red, outside the 24×32 body rect.
    ctx.lineWidth = 2
    ctx.strokeStyle = 'rgba(240,60,60,0.85)'
    ctx.strokeRect(x + 4 - 1, y - 1, 26, 34)

    ctx.restore()
  }

  private blitPart(
    ctx: RenderContext,
    target: RenderTarget,
    x: number,
    y: number,
    part: SpritePart,
  ): void {
    const pixels = part.char.getPixels(ctx)
    const row    = ctx.palette.row(part.palette, ctx)
    target.blit8x8(
      pixels,
      { x: x + part.dx, y: y + part.dy },
      row,
      part.flipX,
      part.flipY,
    )
  }
}
