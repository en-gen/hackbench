// Consumes: editorStore.cursorPx

import type { Char } from '../../chars/Char'
import type { GetL1Tile, OverlayContext } from '../../OverlayContext'
import type { RenderTarget } from '../../RenderTarget'
import { editorStore } from '../../stores/editorStore'
import type { MapStore } from '../../stores/mapStore'
import type { HitRect, SpriteAppearance } from '../SpriteAppearance'
import type { SpriteBehavior } from '../SpriteBehavior'
import { partsHitRect, type SpritePart } from './StaticSpriteAppearance'
import { COLORS, DASH_ALPHA, DASH_LINE_WIDTH, DEFAULT_DASH, rgba } from '../../overlays/primitives'
import { RIP_VAN_FISH_DETECT_HALF_PX } from '../behaviors/RipVanFishBehavior'

/**
 * Sprite $3D — Rip Van Fish. Self-rendering appearance.
 *
 * Frames (per `SprTilemap[$E2..$E5]` and the SpriteMisc1602 dispatch in
 * RipVanFishMain, bank_02.asm:8462):
 *
 *   misc1602=0 ($AE) — chasing A     (state 1, awake)
 *   misc1602=1 ($AC) — chasing B     (state 1, awake)
 *   misc1602=2 ($8C) — sleeping A    (state 0, idle)
 *   misc1602=3 ($8E) — sleeping B    (state 0, idle, alt every misc1570 bit)
 *
 * Sprite-side, the editor only needs ONE static frame per pose: the
 * sprite is shown idle by default and switches to a chasing frame when
 * the cursor enters the wake-up zone (the editor stand-in for Mario).
 * That mirrors Thwomp's alert-vs-aggressive face swap.
 *
 * Defaults:
 *   idle     → frame 2 ($8C, sleepA) — classic asleep, eyes closed
 *   detected → frame 1 ($AC, awakeB) — chasing pose, fins extended
 *
 * Each frame is a single 16×16 SubSprGfx2 big-tile expanded to four
 * 8×8 chars at TL/TR/BL/BR = base, base+1, base+$10, base+$11.
 *
 * Detection-zone overlay: a 96×96 square (±$30 each axis) centered on
 * the spawn — the static `(|dx| < $30) && (|dy| < $30)` check inside
 * CODE_02C02E. Dashed border + faint fill, lime-green to match the
 * patrol-overlay vocabulary for back-and-forth movement sprites.
 */

const OBJ_CHAR_BASE = 0x400
const CORNER_OFFSET = [0x00, 0x01, 0x10, 0x11] as const
const SUB_DX        = [0, 8, 0, 8] as const
const SUB_DY        = [0, 0, 8, 8] as const

/**
 * Expand one 16×16 SNES OAM big-tile into four 8×8 SpriteParts (matches
 * Thwomp's `bigTileParts`). The hardware's large-size bit makes tile N
 * occupy [N, N+1, N+$10, N+$11] for TL/TR/BL/BR.
 */
function bigTileParts(
  chars: Map<number, Char>,
  baseTile: number,
  palette: number,
  charHigh: number,
  placeholder: Char,
): SpritePart[] {
  return [0, 1, 2, 3].map(c => ({
    char: chars.get(OBJ_CHAR_BASE + charHigh + ((baseTile + CORNER_OFFSET[c]) & 0x1FF)) ?? placeholder,
    palette,
    flipX: false,
    flipY: false,
    dx: SUB_DX[c],
    dy: SUB_DY[c],
  }))
}

/** ROM-derived frame base tiles (SprTilemap[$E2..$E5]). */
export const RIP_VAN_FISH_FRAMES = {
  awakeA: 0xAE,   // misc1602=0
  awakeB: 0xAC,   // misc1602=1
  sleepA: 0x8C,   // misc1602=2
  sleepB: 0x8E,   // misc1602=3
} as const

export class RipVanFishAppearance implements SpriteAppearance {
  readonly hitRect: HitRect

  constructor(
    readonly idleParts:     readonly SpritePart[],
    readonly detectedParts: readonly SpritePart[],
  ) {
    this.hitRect = partsHitRect([...idleParts, ...detectedParts])
  }

  static fromTables(
    chars:       Map<number, Char>,
    palette:     number,
    charHigh:    number,
    placeholder: Char,
    idleBase:     number = RIP_VAN_FISH_FRAMES.sleepA,
    detectedBase: number = RIP_VAN_FISH_FRAMES.awakeB,
  ): RipVanFishAppearance {
    return new RipVanFishAppearance(
      bigTileParts(chars, idleBase,     palette, charHigh, placeholder),
      bigTileParts(chars, detectedBase, palette, charHigh, placeholder),
    )
  }

  render(
    target: RenderTarget,
    x: number,
    y: number,
    _behavior: SpriteBehavior,
    mapStore: MapStore,
  ): void {
    // Cursor inside the wake-up square swaps to the chasing pose. Reading
    // editorStore.cursorPx registers this sprite for re-render on cursor
    // moves; the toplevel renderModelOverlay also reads it, so the dep is
    // safe even when the cursor is null.
    const cursor = editorStore.cursorPx
    const cx     = x + 8
    const cy     = y + 8
    const inZone = cursor !== null
      && Math.abs(cursor.x - cx) < RIP_VAN_FISH_DETECT_HALF_PX
      && Math.abs(cursor.y - cy) < RIP_VAN_FISH_DETECT_HALF_PX
    const parts = inZone ? this.detectedParts : this.idleParts
    for (const part of parts) {
      const pixels = part.char.getPixels()
      const row    = mapStore.palette.row(part.palette)
      target.blit8x8(pixels, { x: x + part.dx, y: y + part.dy }, row, part.flipX, part.flipY)
    }
  }

  renderOverlay(
    ctx:        OverlayContext,
    x:          number,
    y:          number,
    isActive:   boolean,
    _getL1:     GetL1Tile,
    _levelCols: number,
    _levelRows: number,
    _behavior:  SpriteBehavior | undefined,
    _mapStore:  MapStore,
  ): void {
    if (!isActive) return
    const cx = x + 8
    const cy = y + 8
    const half = RIP_VAN_FISH_DETECT_HALF_PX
    const left = cx - half
    const top  = cy - half
    const w    = half * 2
    const h    = half * 2
    const color = COLORS.patrolPath

    ctx.save()
    // Faint fill so the zone reads at a glance.
    ctx.fillStyle = rgba(color, 0.10)
    ctx.fillRect(left, top, w, h)
    // Dashed border, same vocabulary as the patrol-line overlays.
    ctx.lineWidth   = DASH_LINE_WIDTH
    ctx.strokeStyle = rgba(color, DASH_ALPHA)
    ctx.setLineDash([...DEFAULT_DASH])
    ctx.strokeRect(left + 0.5, top + 0.5, w - 1, h - 1)
    ctx.setLineDash([])
    ctx.restore()
  }
}
