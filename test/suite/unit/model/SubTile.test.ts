/**
 * SubTile.render — call-through contract.
 *
 * SubTile.render() must:
 *   1. Fetch pixels via char.getPixels(ctx)
 *   2. Fetch palette row via ctx.palette.row(this.palette, ctx)
 *   3. Call target.blit8x8(pixels, pos, row, flipX, flipY, alpha)
 *
 * All six arguments must be forwarded correctly. Tests are written
 * with minimal inline mocks — no ROM or GFX code is loaded.
 */

import { describe, it, expect } from 'vitest'
import { ref } from '@vue/reactivity'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import type { RenderContext, RenderTarget, PixelPos } from '../../../../src/rom/model/RenderTarget'

// Distinct palette rows per index — lets tests assert that the correct
// row index was requested.
const FAKE_ROWS: Record<number, RgbaColor[]> = {
  0: Array(16).fill([0,   0,   0,   255] as RgbaColor),
  3: Array(16).fill([3,   0,   0,   255] as RgbaColor),
  7: Array(16).fill([7,   0,   0,   255] as RgbaColor),
  11: Array(16).fill([11, 0,   0,   255] as RgbaColor),
}

function mockCtx(paletteRowSpy?: (idx: number) => RgbaColor[]): RenderContext {
  return {
    animFrame: ref(0),
    palAnimFrame: ref(0),
    pSwitchActive: ref(false),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette: {
      row: paletteRowSpy ?? ((idx: number) => FAKE_ROWS[idx] ?? FAKE_ROWS[0]),
      color: () => [0, 0, 0, 0] as RgbaColor,
      cells: [] as never,
      backAreaColor: null as never,
    } as never,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, l3: true, sprites: true, screens: true, block: true, mapGrid: false, l3Hud: false, surfaces: false, walls: false }),
  }
}

interface BlitCall {
  pixels: Uint8Array
  pos: PixelPos
  row: RgbaColor[]
  flipX: boolean
  flipY: boolean
  alpha: number | undefined
}

function capturingTarget() {
  const calls: BlitCall[] = []
  const target: RenderTarget = {
    blit8x8(pixels, pos, row, flipX, flipY, alpha) {
      calls.push({ pixels, pos, row, flipX, flipY, alpha })
    },
    fillRect() {},
  }
  return { target, calls }
}

describe('SubTile.render — call contract', () => {
  it('calls blit8x8 exactly once', () => {
    const sub = new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 0, false, false, false)
    const { target, calls } = capturingTarget()
    sub.render(mockCtx(), target, { x: 0, y: 0 })
    expect(calls).toHaveLength(1)
  })

  it('forwards the pos argument as the blit position', () => {
    const sub = new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 0, false, false, false)
    const { target, calls } = capturingTarget()
    const pos: PixelPos = { x: 48, y: 80 }
    sub.render(mockCtx(), target, pos)
    expect(calls[0].pos).toBe(pos)
  })

  it('passes flipX from the constructor', () => {
    const sub = new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 0, true, false, false)
    const { target, calls } = capturingTarget()
    sub.render(mockCtx(), target, { x: 0, y: 0 })
    expect(calls[0].flipX).toBe(true)
  })

  it('passes flipY from the constructor', () => {
    const sub = new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 0, false, true, false)
    const { target, calls } = capturingTarget()
    sub.render(mockCtx(), target, { x: 0, y: 0 })
    expect(calls[0].flipY).toBe(true)
  })

  it('forwards alpha=undefined when no alpha is given', () => {
    const sub = new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 0, false, false, false)
    const { target, calls } = capturingTarget()
    sub.render(mockCtx(), target, { x: 0, y: 0 })
    expect(calls[0].alpha).toBeUndefined()
  })

  it('forwards explicit alpha value', () => {
    const sub = new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 0, false, false, false)
    const { target, calls } = capturingTarget()
    sub.render(mockCtx(), target, { x: 0, y: 0 }, 0.5)
    expect(calls[0].alpha).toBe(0.5)
  })

  it('passes the pixel buffer from char.getPixels(ctx)', () => {
    const pixelData = new Uint8Array(64).fill(7)
    const sub = new SubTile(new Char(0, new StaticPixelsBehavior(pixelData)), 0, false, false, false)
    const { target, calls } = capturingTarget()
    sub.render(mockCtx(), target, { x: 0, y: 0 })
    expect(calls[0].pixels).toBe(pixelData)
  })

  it('requests the correct palette row index from ctx.palette.row', () => {
    const requestedIndices: number[] = []
    const spy = (idx: number) => {
      requestedIndices.push(idx)
      return FAKE_ROWS[0]
    }
    const sub = new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 7, false, false, false)
    const { target } = capturingTarget()
    sub.render(mockCtx(spy), target, { x: 0, y: 0 })
    expect(requestedIndices).toContain(7)
  })

  it('passes the returned palette row to blit8x8', () => {
    const expectedRow = FAKE_ROWS[11]
    const sub = new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 11, false, false, false)
    const { target, calls } = capturingTarget()
    sub.render(mockCtx(), target, { x: 0, y: 0 })
    expect(calls[0].row).toBe(expectedRow)
  })
})
