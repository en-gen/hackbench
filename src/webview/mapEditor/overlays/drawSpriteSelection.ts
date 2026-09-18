import type { Sprite } from '../../../rom/model/sprites/Sprite'

/**
 * Minimal Canvas2D subset needed by `drawSpriteSelection`. Local to this
 * file for the same reason `WallDrawCtx` is local to `drawWalls.ts`.
 */
export interface SelectionDrawCtx {
  strokeStyle: string | CanvasGradient | CanvasPattern
  lineWidth:   number
  save(): void
  restore(): void
  setLineDash(segments: number[]): void
  strokeRect(x: number, y: number, w: number, h: number): void
}

export interface SelectionRect { x: number; y: number; w: number; h: number }

// The mark has to be told apart from two neighbours on this canvas: the
// engine marker's corner ticks, and the sprite annotations. It is therefore
// achromatic and dashed. Every other stroke drawn here is solid and
// hue-coded (camera yellow, vine green, wall purple, L3 magenta), so the
// dash pattern alone carries "this is a selection", and the white reads
// as UI chrome rather than as another data layer.
export const SELECTION_DASH    = [4, 3]
export const SELECTION_COLOR   = '#ffffff'
export const SELECTION_BACKING = 'rgba(0,0,0,0.8)'

const OUTSET = 2

/** Level-pixel rect of the selection mark around a sprite's hit rect. */
export function spriteSelectionRect(sprite: Sprite): SelectionRect {
  const hr = sprite.appearance.hitRect
  return {
    x: sprite.x + hr.dx - OUTSET,
    y: sprite.y + hr.dy - OUTSET,
    w: hr.w + OUTSET * 2,
    h: hr.h + OUTSET * 2,
  }
}

/**
 * Draw the selected-sprite mark, or nothing when `sprite` is null. Two
 * passes: a thicker solid dark backing so the dashes stay visible over
 * bright tiles, then the dashed mark itself.
 */
export function drawSpriteSelection(ctx: SelectionDrawCtx, sprite: Sprite | null): void {
  if (!sprite) return
  const r = spriteSelectionRect(sprite)
  ctx.save()
  ctx.setLineDash([])
  ctx.strokeStyle = SELECTION_BACKING
  ctx.lineWidth = 3
  ctx.strokeRect(r.x - 0.5, r.y - 0.5, r.w + 1, r.h + 1)
  ctx.setLineDash([...SELECTION_DASH])
  ctx.strokeStyle = SELECTION_COLOR
  ctx.lineWidth = 1.5
  ctx.strokeRect(r.x + 0.5, r.y + 0.5, r.w - 1, r.h - 1)
  ctx.restore()
}
