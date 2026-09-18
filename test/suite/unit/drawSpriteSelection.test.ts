/**
 * drawSpriteSelection - the selected-sprite mark on the level canvas.
 *
 * The mark has to stay readable as *selection* next to two other things
 * the editor already draws on the same canvas: the solid-stroked camera
 * rect / vine / range overlays, and the translucent sprite annotations.
 * These tests lock the traits that carry that distinction (dashed stroke,
 * achromatic color, a backing pass) plus the geometry.
 */

import { describe, expect, it } from 'vitest'
import { Sprite } from '../../../src/rom/model/sprites/Sprite'
import type { SpriteAppearance } from '../../../src/rom/model/sprites/SpriteAppearance'
import {
  drawSpriteSelection, SELECTION_DASH, spriteSelectionRect,
} from '../../../src/webview/mapEditor/overlays/drawSpriteSelection'

type RectOp = { x: number; y: number; w: number; h: number; strokeStyle: string; lineWidth: number; dash: number[] }

function makeCtx(): { rects: RectOp[]; saves: number; restores: number } & Record<string, unknown> {
  const rects: RectOp[] = []
  const state = { strokeStyle: '', lineWidth: 0, dash: [] as number[] }
  const ctx = {
    rects,
    saves: 0,
    restores: 0,
    get strokeStyle() { return state.strokeStyle },
    set strokeStyle(v: string) { state.strokeStyle = v },
    get lineWidth() { return state.lineWidth },
    set lineWidth(v: number) { state.lineWidth = v },
    save() { ctx.saves++ },
    restore() { ctx.restores++ },
    setLineDash(d: number[]) { state.dash = [...d] },
    strokeRect(x: number, y: number, w: number, h: number) {
      rects.push({ x, y, w, h, strokeStyle: state.strokeStyle, lineWidth: state.lineWidth, dash: [...state.dash] })
    },
  }
  return ctx as unknown as ReturnType<typeof makeCtx>
}

function spriteWith(hitRect: { dx: number; dy: number; w: number; h: number }, x = 32, y = 48): Sprite {
  const appearance = { hitRect, render: () => {} } as unknown as SpriteAppearance
  return new Sprite(0x0F, x, y, appearance, { kind: 'k' })
}

describe('spriteSelectionRect', () => {
  it('surrounds the appearance hit rect with an outset margin', () => {
    const r = spriteSelectionRect(spriteWith({ dx: 0, dy: 0, w: 16, h: 16 }))
    expect(r.w).toBeGreaterThan(16)
    expect(r.h).toBeGreaterThan(16)
    expect(r.x).toBeLessThan(32)
    expect(r.y).toBeLessThan(48)
  })

  it('honours a hit rect offset from the sprite origin', () => {
    const plain   = spriteSelectionRect(spriteWith({ dx: 0, dy: 0, w: 16, h: 16 }))
    const shifted = spriteSelectionRect(spriteWith({ dx: -8, dy: 16, w: 16, h: 16 }))
    expect(shifted.x).toBe(plain.x - 8)
    expect(shifted.y).toBe(plain.y + 16)
  })

  it('grows with a multi-part sprite', () => {
    const r = spriteSelectionRect(spriteWith({ dx: 0, dy: 0, w: 64, h: 64 }))
    expect(r.w).toBeGreaterThan(64)
    expect(r.h).toBeGreaterThan(64)
  })
})

describe('drawSpriteSelection', () => {
  it('draws nothing when there is no selection', () => {
    const ctx = makeCtx()
    drawSpriteSelection(ctx, null)
    expect(ctx.rects).toHaveLength(0)
    expect(ctx.saves).toBe(0)
  })

  it('draws a backing pass and a dashed mark pass', () => {
    const ctx = makeCtx()
    drawSpriteSelection(ctx, spriteWith({ dx: 0, dy: 0, w: 16, h: 16 }))
    expect(ctx.rects).toHaveLength(2)
    const [backing, mark] = ctx.rects
    expect(backing.dash).toEqual([])
    expect(mark.dash).toEqual([...SELECTION_DASH])
  })

  it('uses a dashed stroke, which no solid-stroked overlay on this canvas does', () => {
    const ctx = makeCtx()
    drawSpriteSelection(ctx, spriteWith({ dx: 0, dy: 0, w: 16, h: 16 }))
    expect(ctx.rects.some(r => r.dash.length > 0)).toBe(true)
  })

  it('uses an achromatic mark so it cannot be read as a hue-coded overlay', () => {
    const ctx = makeCtx()
    drawSpriteSelection(ctx, spriteWith({ dx: 0, dy: 0, w: 16, h: 16 }))
    const mark = ctx.rects[1]
    expect(mark.strokeStyle).toMatch(/^#(fff|ffffff)$/i)
  })

  it('draws the backing thicker than the mark so the dashes read on any tile', () => {
    const ctx = makeCtx()
    drawSpriteSelection(ctx, spriteWith({ dx: 0, dy: 0, w: 16, h: 16 }))
    expect(ctx.rects[0].lineWidth).toBeGreaterThan(ctx.rects[1].lineWidth)
  })

  it('balances save and restore so it cannot leak dash state into later overlays', () => {
    const ctx = makeCtx()
    drawSpriteSelection(ctx, spriteWith({ dx: 0, dy: 0, w: 16, h: 16 }))
    expect(ctx.saves).toBe(1)
    expect(ctx.restores).toBe(1)
  })

  it('positions the mark at the sprite it was given', () => {
    const ctx = makeCtx()
    drawSpriteSelection(ctx, spriteWith({ dx: 0, dy: 0, w: 16, h: 16 }, 160, 96))
    expect(ctx.rects[1].x).toBeGreaterThan(150)
    expect(ctx.rects[1].x).toBeLessThan(162)
    expect(ctx.rects[1].y).toBeGreaterThan(86)
    expect(ctx.rects[1].y).toBeLessThan(98)
  })
})
