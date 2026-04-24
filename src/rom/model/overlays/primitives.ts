import type { OverlayContext } from '../OverlayContext'

/**
 * Shared Canvas2D drawing primitives used by sprite appearance `renderOverlay`
 * implementations. Every overlay in the editor composes from these to keep
 * visual language consistent (dashed envelopes, solid wall edges, apex
 * markers, fade trails).
 *
 * This is deliberately NOT a discriminated-union "OverlayPlan" renderer —
 * appearances own their overlay compositions because sprite-specific detail
 * (Thwomp fall path vs. Rip Van Fish detect zone vs. Para-Koopa patrol)
 * doesn't fit one schema. Behaviors produce *data*; appearances compose
 * *drawings*; these primitives are the vocabulary.
 *
 * All coordinates are in level pixels.
 */

export interface RGBA {
  r: number  // 0..255
  g: number  // 0..255
  b: number  // 0..255
}

/** Nearly-opaque (0.85) rgba string from a colour triple. */
export function rgba(c: RGBA, a: number): string {
  return `rgba(${c.r},${c.g},${c.b},${a})`
}

export const FILL_ALPHA       = 0.15
export const DASH_ALPHA       = 0.55
export const WALL_ALPHA       = 0.90
export const APEX_ALPHA       = 0.85
export const GROUND_ALPHA     = 0.18
export const DEFAULT_DASH     = [4, 3] as const
export const WALL_LINE_WIDTH  = 2
export const DASH_LINE_WIDTH  = 1
export const APEX_LINE_WIDTH  = 2

/**
 * Draw a translucent fill + dashed outline rectangle. Used for the baseline
 * "tinted region" of most overlays. Rectangle is inset by 0.5px on each side
 * so the stroke lands on whole pixels at lineWidth=1.
 */
export function drawOverlayRect(
  ctx:   OverlayContext,
  x:     number,
  y:     number,
  w:     number,
  h:     number,
  color: RGBA,
  opts?: { fillAlpha?: number; dashAlpha?: number; dash?: readonly number[] },
): void {
  const fillAlpha = opts?.fillAlpha ?? FILL_ALPHA
  const dashAlpha = opts?.dashAlpha ?? DASH_ALPHA
  const dash      = opts?.dash      ?? DEFAULT_DASH
  ctx.fillStyle = rgba(color, fillAlpha)
  ctx.fillRect(x, y, w, h)
  ctx.lineWidth = DASH_LINE_WIDTH
  ctx.setLineDash([...dash])
  ctx.strokeStyle = rgba(color, dashAlpha)
  ctx.strokeRect(x + 0.5, y + 0.5, w - 1, h - 1)
  ctx.setLineDash([])
}

/**
 * Horizontal corridor: translucent band from leftX..rightX at topY..bottomY,
 * with solid wall lines at any edge marked "solid" (bounded by a real wall
 * tile) and dashed everywhere else.
 */
export function drawCorridor(
  ctx:       OverlayContext,
  leftX:     number,
  rightX:    number,
  topY:      number,
  bottomY:   number,
  color:     RGBA,
  walls?:    { solidLeft?: boolean; solidRight?: boolean; solidTop?: boolean; solidBottom?: boolean },
): void {
  const w = rightX - leftX
  const h = bottomY - topY
  drawOverlayRect(ctx, leftX, topY, w, h, color)

  if (walls?.solidLeft || walls?.solidRight || walls?.solidTop || walls?.solidBottom) {
    ctx.lineWidth = WALL_LINE_WIDTH
    ctx.strokeStyle = rgba(color, WALL_ALPHA)
    ctx.beginPath()
    if (walls.solidLeft)   { ctx.moveTo(leftX,  topY);    ctx.lineTo(leftX,  bottomY) }
    if (walls.solidRight)  { ctx.moveTo(rightX, topY);    ctx.lineTo(rightX, bottomY) }
    if (walls.solidTop)    { ctx.moveTo(leftX,  topY);    ctx.lineTo(rightX, topY)    }
    if (walls.solidBottom) { ctx.moveTo(leftX,  bottomY); ctx.lineTo(rightX, bottomY) }
    ctx.stroke()
  }
}

/**
 * Vertical lane: a narrow column centred on `centerX` extending `minY..maxY`,
 * with total width `halfWidth * 2`. Used for straight-vertical movement
 * (jumping fish, vertical para-koopa).
 */
export function drawVertLane(
  ctx:       OverlayContext,
  centerX:   number,
  minY:      number,
  maxY:      number,
  halfWidth: number,
  color:     RGBA,
): void {
  drawOverlayRect(ctx, centerX - halfWidth, minY, halfWidth * 2, maxY - minY, color)
}

/**
 * Apex marker: solid horizontal line at the top (or bottom) of a movement
 * envelope. Distinguishes the absolute extreme of travel from the bulk of
 * the envelope. Draws at integer y to avoid blurry pixels.
 */
export function drawApexLine(
  ctx:   OverlayContext,
  x1:    number,
  x2:    number,
  y:     number,
  color: RGBA,
  opts?: { alpha?: number; lineWidth?: number },
): void {
  ctx.lineWidth = opts?.lineWidth ?? APEX_LINE_WIDTH
  ctx.strokeStyle = rgba(color, opts?.alpha ?? APEX_ALPHA)
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(x1, y)
  ctx.lineTo(x2, y)
  ctx.stroke()
}

/**
 * Fade corridor: gradient-alpha tint from `originX`/`originY` outward to
 * `endX` (can be left or right of origin). Used for sprites that move
 * forever in one direction through walls ($08 Green Para-Koopa).
 *
 * The fade is linear from `fillAlpha` at origin to 0 at endX. The height is
 * centred on `originY` (±`heightPx/2`). A dashed border is omitted because
 * a fading corridor looks less "bounded" without one, reinforcing the
 * "endless movement" intent.
 */
export function drawFadeCorridor(
  ctx:      OverlayContext,
  originX:  number,
  originY:  number,
  endX:     number,
  heightPx: number,
  color:    RGBA,
  opts?:    { fillAlpha?: number; steps?: number },
): void {
  const fillAlpha = opts?.fillAlpha ?? 0.32
  const steps     = opts?.steps     ?? 12
  const dx = endX - originX
  const stepW = dx / steps
  const halfH = heightPx / 2
  const y = originY - halfH
  for (let i = 0; i < steps; i++) {
    const t = i / (steps - 1 || 1)         // 0..1
    const a = fillAlpha * (1 - t)
    ctx.fillStyle = rgba(color, a)
    // Overlap slightly to avoid seams when the stroke renderer interpolates.
    const x = originX + i * stepW
    ctx.fillRect(x, y, stepW + 0.5, heightPx)
  }
}

/**
 * Bounce arc: draw the envelope rectangle (dashed) plus the polyline of
 * bounce peaks. `bouncePoints` is a list of positions visited at bounce
 * apex moments — drawing them as a polyline gives the classic "see where
 * it lands" overlay without flooding the canvas with every simulation
 * frame.
 */
export function drawBounceArc(
  ctx:         OverlayContext,
  envelope:    { minX: number; maxX: number; minY: number; maxY: number },
  bouncePath:  readonly { x: number; y: number }[],
  color:       RGBA,
): void {
  drawOverlayRect(
    ctx,
    envelope.minX, envelope.minY,
    envelope.maxX - envelope.minX,
    envelope.maxY - envelope.minY,
    color,
  )
  if (bouncePath.length < 2) return
  ctx.lineWidth = DASH_LINE_WIDTH + 0.5
  ctx.strokeStyle = rgba(color, WALL_ALPHA)
  ctx.setLineDash([])
  ctx.beginPath()
  ctx.moveTo(bouncePath[0].x, bouncePath[0].y)
  for (let i = 1; i < bouncePath.length; i++) {
    ctx.lineTo(bouncePath[i].x, bouncePath[i].y)
  }
  ctx.stroke()
}

/**
 * Sine band: draw an envelope plus a sampled sine curve through it.
 * `axis: 'vertical'` → Y oscillates around `originY` with amplitude;
 * `axis: 'horizontal'` → X oscillates around `originX`. Amplitude is the
 * max displacement from origin; the sine is rendered as a polyline.
 */
export function drawSineBand(
  ctx:       OverlayContext,
  originX:   number,
  originY:   number,
  axis:      'vertical' | 'horizontal',
  amplitude: number,
  color:     RGBA,
  opts?:     { halfWidth?: number; samples?: number; cycles?: number },
): void {
  const halfW   = opts?.halfWidth ?? 8
  const samples = opts?.samples   ?? 48
  const cycles  = opts?.cycles    ?? 1.5
  if (axis === 'vertical') {
    drawOverlayRect(
      ctx,
      originX - halfW, originY - amplitude,
      halfW * 2, amplitude * 2,
      color,
    )
    ctx.lineWidth = DASH_LINE_WIDTH + 0.5
    ctx.strokeStyle = rgba(color, WALL_ALPHA)
    ctx.beginPath()
    for (let i = 0; i <= samples; i++) {
      const t  = i / samples
      const dy = Math.sin(t * Math.PI * 2 * cycles) * amplitude
      const x  = originX + (t - 0.5) * halfW * 0.4
      const y  = originY + dy
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
  } else {
    drawOverlayRect(
      ctx,
      originX - amplitude, originY - halfW,
      amplitude * 2, halfW * 2,
      color,
    )
    ctx.lineWidth = DASH_LINE_WIDTH + 0.5
    ctx.strokeStyle = rgba(color, WALL_ALPHA)
    ctx.beginPath()
    for (let i = 0; i <= samples; i++) {
      const t  = i / samples
      const dx = Math.sin(t * Math.PI * 2 * cycles) * amplitude
      const x  = originX + dx
      const y  = originY + (t - 0.5) * halfW * 0.4
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y)
    }
    ctx.stroke()
  }
}

/**
 * Dotted vertical drop line — indicates a sprite spawns airborne and
 * falls from `fromY` down to `toY` before beginning its movement. Drawn
 * at `centerX` (1px wide, dashed). Reusable by any sprite that spawns
 * off the ground: koopas, para-goombas after wings drop, fish above
 * water, etc.
 */
export function drawSpawnDrop(
  ctx:     OverlayContext,
  centerX: number,
  fromY:   number,
  toY:     number,
  color:   RGBA,
  opts?:   { alpha?: number; dash?: readonly number[] },
): void {
  if (toY <= fromY) return
  ctx.save()
  ctx.lineWidth = DASH_LINE_WIDTH
  ctx.strokeStyle = rgba(color, opts?.alpha ?? DASH_ALPHA)
  ctx.setLineDash([...(opts?.dash ?? [2, 3])])
  ctx.beginPath()
  ctx.moveTo(centerX + 0.5, fromY)
  ctx.lineTo(centerX + 0.5, toY)
  ctx.stroke()
  ctx.setLineDash([])
  ctx.restore()
}

/**
 * Schematic fall-off indicator — an L-shaped band that extends from the
 * ledge edge horizontally (the body continues outward "into air") and
 * then turns 90° downward for the fall. Intentionally stylised: a *where
 * it goes* hint, not a physics-accurate trajectory.
 *
 * Visual composition:
 *   - Horizontal band: solid fill + dashed outline (like `drawCorridor`).
 *   - Vertical band:   top→bottom alpha gradient (fills + side outlines
 *                      both fade to 0 at the bottom).
 *   - Hidden edges:    the junction line where the vertical meets the
 *                      horizontal, and the bottom of the vertical. The
 *                      gradient is the only boundary signal at the
 *                      bottom — no hard line there.
 *
 * `ledgeX` is the x of the ledge edge (left edge of the first open
 * column for a right-fall; right edge of the last open column for a
 * left-fall). `direction`: +1 extends right, -1 extends left.
 */
export function drawFallL(
  ctx:      OverlayContext,
  ledgeX:   number,
  topY:     number,
  bottomY:  number,
  direction: -1 | 1,
  color:    RGBA,
  opts?:    {
    horizontalTiles?: number
    verticalTiles?:   number
    verticalWidth?:   number
    fillAlpha?:       number
    dashAlpha?:       number
  },
): void {
  // Default horizontal = 3 tiles, vertical = 2 tiles wide. Vertical
  // thickness matches the sprite body height (2 tiles tall = 2 tiles
  // wide). Horizontal being wider gives an actual L with an inner
  // corner of 1 tile on the near-side of the vertical band.
  const horizW = (opts?.horizontalTiles ?? 3) * 16
  const vertH  = (opts?.verticalTiles   ?? 2) * 16
  const vertW  =  opts?.verticalWidth   ?? 32
  const fA = opts?.fillAlpha ?? FILL_ALPHA
  const dA = opts?.dashAlpha ?? DASH_ALPHA

  // Horizontal corners.
  const hxL = direction > 0 ? ledgeX          : ledgeX - horizW
  const hxR = direction > 0 ? ledgeX + horizW : ledgeX
  // Vertical corners — drops from the FAR end of the horizontal. `vxNear`
  // is the edge of the vertical band that sits flush with the horizontal's
  // bottom; `vxFar` is the edge that aligns with the horizontal's far side.
  const vxFar  = direction > 0 ? hxR         : hxL
  const vxNear = direction > 0 ? hxR - vertW : hxL + vertW
  const vxLeft = Math.min(vxFar, vxNear)
  const vyT = bottomY
  const vyB = bottomY + vertH

  ctx.save()

  // Fills: horizontal solid, vertical gradient (top = fA → bottom = 0).
  ctx.fillStyle = rgba(color, fA)
  ctx.fillRect(hxL, topY, horizW, bottomY - topY)
  const fillGrad = ctx.createLinearGradient(0, vyT, 0, vyB)
  fillGrad.addColorStop(0, rgba(color, fA))
  fillGrad.addColorStop(1, rgba(color, 0))
  ctx.fillStyle = fillGrad
  ctx.fillRect(vxLeft, vyT, vertW, vertH)

  // Dashed outline setup.
  ctx.lineWidth = DASH_LINE_WIDTH
  ctx.setLineDash([...DEFAULT_DASH])

  // Outline — L perimeter MINUS the bottom edge of the vertical band.
  // The missing bottom signals that the koopa keeps falling past the
  // rendered drop zone; closing it off with a hard line would read as
  // "fall terminates here" which isn't what the overlay means.
  //
  // Five segments drawn (six in a closed L; bottom of vertical skipped):
  //   1. top of horizontal
  //   2. near side of horizontal (platform-edge side, half height)
  //   3. visible part of horizontal's bottom (near → inner corner)
  //   4. inner edge of L (inner corner down to vyB)
  //   5. far side (full height topY..vyB — from top of horizontal band
  //      through the outer edge of the vertical band)
  ctx.strokeStyle = rgba(color, dA)
  ctx.beginPath()
  ctx.moveTo(hxL, topY + 0.5)
  ctx.lineTo(hxR, topY + 0.5)
  if (direction > 0) {
    // Right fall — vertical drops from the far RIGHT end.
    // Near side (LEFT of horizontal)
    ctx.moveTo(hxL + 0.5, topY)
    ctx.lineTo(hxL + 0.5, bottomY)
    // Visible horizontal bottom (left of inner corner)
    ctx.moveTo(hxL, bottomY - 0.5)
    ctx.lineTo(vxNear, bottomY - 0.5)
    // Inner edge (down from inner corner)
    ctx.moveTo(vxNear + 0.5, bottomY)
    ctx.lineTo(vxNear + 0.5, vyB)
    // Far side (RIGHT) full height
    ctx.moveTo(hxR - 0.5, topY)
    ctx.lineTo(hxR - 0.5, vyB)
  } else {
    // Left fall — vertical drops from the far LEFT end.
    // Near side (RIGHT of horizontal)
    ctx.moveTo(hxR - 0.5, topY)
    ctx.lineTo(hxR - 0.5, bottomY)
    // Visible horizontal bottom (right of inner corner)
    ctx.moveTo(vxNear, bottomY - 0.5)
    ctx.lineTo(hxR, bottomY - 0.5)
    // Inner edge (down from inner corner)
    ctx.moveTo(vxNear - 0.5, bottomY)
    ctx.lineTo(vxNear - 0.5, vyB)
    // Far side (LEFT) full height
    ctx.moveTo(hxL + 0.5, topY)
    ctx.lineTo(hxL + 0.5, vyB)
  }
  ctx.stroke()

  ctx.setLineDash([])
  ctx.restore()
}

/**
 * Scan columns of a grid in a direction (-1 left, +1 right) from `startCol`,
 * returning the pixel X at the nearest solid boundary. Used to derive patrol
 * corridor widths from the L1 acts-like grid. If no solid column is found
 * within `[0, limit)`, returns the level-edge X (`0` for left, `limit*16`
 * for right).
 *
 * `isSolid(c)` should encapsulate body-row vertical scan and acts-like check
 * — callers pass in a closure that handles per-sprite geometry.
 */
export function findSolidBoundary(
  isSolid:   (col: number) => boolean,
  startCol:  number,
  direction: -1 | 1,
  limit:     number,
): number {
  if (direction === -1) {
    for (let c = startCol - 1; c >= 0; c--) {
      if (isSolid(c)) return (c + 1) * 16
    }
    return 0
  } else {
    for (let c = startCol + 1; c < limit; c++) {
      if (isSolid(c)) return c * 16
    }
    return limit * 16
  }
}

/** Commonly used overlay colours, keeping visual vocabulary consistent. */
export const COLORS = {
  orangeHop:     { r: 255, g: 120, b:   0 } as RGBA,  // HopFlame envelope
  orangeGround:  { r: 255, g: 150, b:   0 } as RGBA,  // ground band accent
  cyanKoopa:     { r:   0, g: 200, b: 255 } as RGBA,  // para-koopa movement
  purpleYellow:  { r: 180, g:  80, b: 255 } as RGBA,  // yellow para-koopa corridor
  greenGround:   { r: 110, g: 220, b: 120 } as RGBA,  // ground koopa patrol
  redWarning:    { r: 255, g:  80, b:  80 } as RGBA,  // hostile reach
  tealSwim:      { r:   0, g: 200, b: 220 } as RGBA,  // swimming sprites (cheep-cheep / fish)
  tealJump:      { r:   0, g: 200, b: 140 } as RGBA,  // jumping fish column
} as const
