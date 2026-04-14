/**
 * Canvas-based level renderer — shared between the webview and any future
 * thumbnail generation code.
 *
 * Draws a structural visualisation of parsed level data:
 *   - Colored blocks for layer-1 objects
 *   - Diamond markers for sprites
 *   - Screen divider lines
 *   - Optional tile grid
 *
 * This is the interim renderer; it will be replaced/augmented once the full
 * GFX + palette pipeline is wired up (see docs/level-rendering.md).
 */

import type { ParsedLevel, LevelObject } from '../../rom/LevelParser'

export interface RenderOptions {
  tileSize?: number
  showGrid?: boolean
  showSprites?: boolean
  showObjects?: boolean
}

const SCREEN_W = 16

const OBJECT_COLORS = [
  '#4a7a4a', '#5a8a5a', '#3a6a3a', '#6a9a6a',
  '#7a6a3a', '#9a8a4a', '#6a5a2a', '#8a7a3a',
  '#5a5a9a', '#6a6aaa', '#4a4a8a', '#7a7abb',
  '#9a4a4a', '#aa5a5a', '#8a3a3a', '#bb6a6a',
]

export function renderLevel(
  canvas: HTMLCanvasElement,
  level: ParsedLevel,
  opts: RenderOptions = {}
): void {
  const { tileSize = 16, showGrid = true, showSprites = true, showObjects = true } = opts
  const ctx = canvas.getContext('2d')!
  const W = canvas.width
  const H = canvas.height

  // Background
  ctx.fillStyle = '#1a2a1a'
  ctx.fillRect(0, 0, W, H)

  // Screen dividers + labels
  for (let s = 0; s < level.screens; s++) {
    const x = s * SCREEN_W * tileSize
    if (s > 0) {
      ctx.strokeStyle = 'rgba(255,255,255,0.08)'
      ctx.lineWidth = 1
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
    }
    ctx.fillStyle = 'rgba(255,255,255,0.15)'
    ctx.font = `${tileSize * 0.7}px monospace`
    ctx.textAlign = 'left'
    ctx.fillText(`${s}`, x + 4, tileSize * 1.2)
  }

  // Objects
  if (showObjects) {
    for (const obj of level.objects) {
      drawObject(ctx, obj, tileSize)
    }
  }

  // Sprites
  if (showSprites) {
    for (const spr of level.sprites) {
      const cx = spr.x * tileSize + tileSize / 2
      const cy = spr.y * tileSize + tileSize / 2
      const r = tileSize * 0.35
      ctx.beginPath()
      ctx.moveTo(cx, cy - r); ctx.lineTo(cx + r, cy)
      ctx.lineTo(cx, cy + r); ctx.lineTo(cx - r, cy)
      ctx.closePath()
      ctx.fillStyle = '#cc8822cc'
      ctx.fill()
      ctx.strokeStyle = '#ffaa44'
      ctx.lineWidth = 1
      ctx.stroke()
      if (tileSize >= 14) {
        ctx.fillStyle = '#fff'
        ctx.font = `bold ${Math.max(7, tileSize * 0.42)}px monospace`
        ctx.textAlign = 'center'
        ctx.fillText(spr.spriteId.toString(16).toUpperCase().padStart(2, '0'), cx, cy + tileSize * 0.17)
      }
    }
  }

  // Grid
  if (showGrid) {
    ctx.strokeStyle = 'rgba(255,255,255,0.04)'
    ctx.lineWidth = 0.5
    for (let x = 0; x <= W; x += tileSize) {
      ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke()
    }
    for (let y = 0; y <= H; y += tileSize) {
      ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(W, y); ctx.stroke()
    }
  }
}

function drawObject(ctx: CanvasRenderingContext2D, obj: LevelObject, ts: number): void {
  const px = obj.x * ts
  const py = obj.y * ts
  const w = (obj.param + 1) * ts
  const color = obj.type === 'extended' ? '#8a6aaa' : OBJECT_COLORS[obj.objectType & 0xF]

  ctx.fillStyle = color + 'aa'
  ctx.fillRect(px, py, w, ts)
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.strokeRect(px + 0.5, py + 0.5, w - 1, ts - 1)

  if (ts >= 12) {
    ctx.fillStyle = 'rgba(255,255,255,0.7)'
    ctx.font = `${Math.max(8, ts * 0.5)}px monospace`
    ctx.textAlign = 'center'
    const label = obj.type === 'extended'
      ? 'E' + (obj.objectType - 0x100).toString(16).toUpperCase()
      : obj.objectType.toString(16).toUpperCase()
    ctx.fillText(label, px + ts / 2, py + ts * 0.68)
  }
}
