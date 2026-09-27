/**
 * `ZoomController`'s wheel accumulation, clamping and anchor math (#651),
 * exercised with no real DOM. No `@theia/core` import anywhere in this
 * file's own graph - see zoom-controller.ts's doc comment on why CI needs
 * that (`npm ci` alone, no `theia/node_modules`).
 */
import { describe, it, expect, vi } from 'vitest'
import { ZoomController } from '../../../theia/extension/src/browser/zoom-controller'

/** Minimal stand-in for the scroll container `bindWheel` listens on. */
class FakeNode {
  scrollLeft = 0
  scrollTop = 0
  private readonly handlers: Array<(e: FakeWheelEvent) => void> = []

  constructor(private readonly rect = { left: 0, top: 0 }) {}

  addEventListener(type: string, fn: (e: FakeWheelEvent) => void): void {
    if (type === 'wheel') this.handlers.push(fn)
  }

  removeEventListener(type: string, fn: (e: FakeWheelEvent) => void): void {
    if (type !== 'wheel') return
    const i = this.handlers.indexOf(fn)
    if (i >= 0) this.handlers.splice(i, 1)
  }

  getBoundingClientRect() {
    return { left: this.rect.left, top: this.rect.top, right: 0, bottom: 0, width: 0, height: 0 }
  }

  dispatch(e: FakeWheelEvent): void {
    for (const fn of [...this.handlers]) fn(e)
  }

  get listenerCount(): number {
    return this.handlers.length
  }
}

interface FakeWheelEvent {
  ctrlKey: boolean
  deltaY: number
  clientX: number
  clientY: number
  preventDefault: () => void
  prevented: boolean
}

function wheelEvent(
  deltaY: number,
  opts: Partial<Pick<FakeWheelEvent, 'ctrlKey' | 'clientX' | 'clientY'>> = {},
): FakeWheelEvent {
  const e: FakeWheelEvent = {
    ctrlKey: opts.ctrlKey ?? true,
    deltaY,
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
    prevented: false,
    preventDefault(): void {
      e.prevented = true
    },
  }
  return e
}

// `bindWheel` takes an HTMLElement/canvas; the fakes implement exactly the
// surface it calls, so the cast is the intended seam, not a shortcut.
function bind(c: ZoomController, node: FakeNode, canvas: FakeNode | null = node) {
  return c.bindWheel(node as unknown as HTMLElement, () => canvas as unknown as HTMLElement | null)
}

const MAP16_LEVELS = [1, 2, 3, 4]
const GFX_LEVELS = [1, 2, 3, 4, 6, 8]

describe('ZoomController.step - clamping', () => {
  it.each([
    { levels: MAP16_LEVELS, initial: 4, dir: 1 as const, expectMoved: false, expectValue: 4 },
    { levels: MAP16_LEVELS, initial: 1, dir: -1 as const, expectMoved: false, expectValue: 1 },
    { levels: MAP16_LEVELS, initial: 2, dir: 1 as const, expectMoved: true, expectValue: 3 },
    { levels: MAP16_LEVELS, initial: 2, dir: -1 as const, expectMoved: true, expectValue: 1 },
    { levels: GFX_LEVELS, initial: 8, dir: 1 as const, expectMoved: false, expectValue: 8 },
  ])('%#: %j', ({ levels, initial, dir, expectMoved, expectValue }) => {
    const c = new ZoomController(levels, initial)
    const listener = vi.fn()
    c.onDidChange(listener)
    expect(c.step(dir)).toBe(expectMoved)
    expect(c.value).toBe(expectValue)
    expect(listener).toHaveBeenCalledTimes(expectMoved ? 1 : 0)
  })

  it('falls back to the first level when the initial value is not one of them', () => {
    expect(new ZoomController(MAP16_LEVELS, 99).value).toBe(1)
  })

  it('canZoomIn/canZoomOut reflect the clamp', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    expect(c.canZoomOut).toBe(false)
    expect(c.canZoomIn).toBe(true)
    c.step(1)
    c.step(1)
    c.step(1)
    expect(c.canZoomIn).toBe(false)
    expect(c.canZoomOut).toBe(true)
  })

  it('a disposed onDidChange subscription stops receiving changes', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const listener = vi.fn()
    c.onDidChange(listener).dispose()
    c.step(1)
    expect(listener).not.toHaveBeenCalled()
  })
})

describe('ZoomController.bindWheel - threshold, direction, ctrlKey', () => {
  it.each([
    { initial: 1, deltas: [-40, -40], expectValue: 1, why: 'below the 100px threshold' },
    { initial: 1, deltas: [-40, -40, -40], expectValue: 2, why: 'crosses 100px' },
    {
      initial: 1,
      deltas: [-40, -40, -40, -40],
      expectValue: 2,
      why: 'remainder discarded, not carried',
    },
    { initial: 1, deltas: [-100], expectValue: 2, why: 'negative deltaY zooms in' },
    { initial: 4, deltas: [100], expectValue: 3, why: 'positive deltaY zooms out' },
  ])('$why', ({ initial, deltas, expectValue }) => {
    const c = new ZoomController(MAP16_LEVELS, initial)
    const node = new FakeNode()
    bind(c, node)
    for (const d of deltas) node.dispatch(wheelEvent(d))
    expect(c.value).toBe(expectValue)
  })

  it('resets the accumulator on a direction reversal, rather than carrying stale credit across', () => {
    const c = new ZoomController(MAP16_LEVELS, 2)
    const node = new FakeNode()
    bind(c, node)
    node.dispatch(wheelEvent(-60)) // zoom-in credit: 60px
    node.dispatch(wheelEvent(60)) // reversal: resets, then 60px zoom-out credit
    expect(c.value).toBe(2) // neither direction has reached 100px yet
    node.dispatch(wheelEvent(50)) // zoom-out credit: 110px since the reversal
    expect(c.value).toBe(1) // one zoom-OUT step, not zoom-in from stale credit
  })

  it('ignores a plain wheel and does not preventDefault it', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeNode()
    bind(c, node)
    const e = wheelEvent(-500, { ctrlKey: false })
    node.dispatch(e)
    expect(c.value).toBe(1)
    expect(e.prevented).toBe(false)
  })

  it('preventDefault()s a Ctrl + wheel event even below the step threshold', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeNode()
    bind(c, node)
    const e = wheelEvent(-10, { ctrlKey: true })
    node.dispatch(e)
    expect(e.prevented).toBe(true)
    expect(c.value).toBe(1)
  })

  it('disposing the binding removes the listener', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeNode()
    const binding = bind(c, node)
    expect(node.listenerCount).toBe(1)
    binding.dispose()
    expect(node.listenerCount).toBe(0)
    node.dispatch(wheelEvent(-500))
    expect(c.value).toBe(1)
  })
})

describe('ZoomController - anchoring', () => {
  /** A wrap with padding and scroll, and a canvas whose box is NOT the
   * scroller's own box - the shape `restoreAnchor`'s math has to survive. */
  function paddedLayout() {
    const node = new FakeNode({ left: 10, top: 5 }) // scroller's own border box
    node.scrollLeft = 50
    node.scrollTop = 20
    const canvas = new FakeNode({ left: 10 + 19 - 50, top: 5 + 19 - 20 }) // 19px padding, minus scroll
    return { node, canvas }
  }

  it('restores scroll so the same canvas pixel sits under the cursor, within 1px, through padding/scroll offset', () => {
    const c = new ZoomController(MAP16_LEVELS, 2) // starts at 2x
    const { node, canvas } = paddedLayout()
    const binding = bind(c, node, canvas)
    const canvasRect = canvas.getBoundingClientRect()
    const scrollerRect = node.getBoundingClientRect()
    const scrollLeftBefore = node.scrollLeft
    const scrollTopBefore = node.scrollTop

    const clientX = canvasRect.left + 100 // 100px into the canvas, at 2x
    const clientY = canvasRect.top + 100
    node.dispatch(wheelEvent(-120, { clientX, clientY }))
    expect(c.value).toBe(3)

    binding.restoreAnchor()

    // Content point (50, 50) - (100, 100) at the OLD 2x zoom - must sit
    // back under the same client point at the NEW 3x zoom. The independent
    // check: convert the new scroll position back to a canvas-space point
    // and confirm it is (50, 50) again, within 1px.
    const canvasOffsetX = canvasRect.left - scrollerRect.left + scrollLeftBefore
    const canvasOffsetY = canvasRect.top - scrollerRect.top + scrollTopBefore
    const cursorOffsetX = clientX - scrollerRect.left
    const cursorOffsetY = clientY - scrollerRect.top
    const resultContentX = (node.scrollLeft - canvasOffsetX + cursorOffsetX) / c.value
    const resultContentY = (node.scrollTop - canvasOffsetY + cursorOffsetY) / c.value
    expect(Math.abs(resultContentX - 50)).toBeLessThan(1)
    expect(Math.abs(resultContentY - 50)).toBeLessThan(1)
  })

  it('produces no anchor at a clamp, so restoreAnchor is a no-op', () => {
    const c = new ZoomController(MAP16_LEVELS, 4) // already at the top
    const { node, canvas } = paddedLayout()
    const binding = bind(c, node, canvas)
    const before = { scrollLeft: node.scrollLeft, scrollTop: node.scrollTop }
    node.dispatch(wheelEvent(-500)) // tries to zoom in past the clamp
    expect(c.value).toBe(4)
    binding.restoreAnchor()
    expect(node.scrollLeft).toBe(before.scrollLeft)
    expect(node.scrollTop).toBe(before.scrollTop)
  })

  it('a button step (not wheel-driven) invalidates a pending wheel anchor', () => {
    const c = new ZoomController(MAP16_LEVELS, 2)
    const { node, canvas } = paddedLayout()
    const binding = bind(c, node, canvas)
    node.dispatch(wheelEvent(-120)) // wheel step to 3x, anchor pending for 3x
    expect(c.value).toBe(3)

    c.step(1) // a ZoomStepper button click: zoom moves again, to 4x

    const before = { scrollLeft: node.scrollLeft, scrollTop: node.scrollTop }
    binding.restoreAnchor() // the pending anchor targeted 3x; current value is 4x
    expect(node.scrollLeft).toBe(before.scrollLeft)
    expect(node.scrollTop).toBe(before.scrollTop)
  })

  it("consecutive notches before a repaint keep the FIRST notch's content point, refreshing only the cursor offset", () => {
    const c = new ZoomController(GFX_LEVELS, 1)
    const { node, canvas } = paddedLayout()
    const binding = bind(c, node, canvas)
    const canvasRect = canvas.getBoundingClientRect()
    const scrollerRect = node.getBoundingClientRect()
    const initialScrollLeft = node.scrollLeft
    const initialScrollTop = node.scrollTop

    // First notch at zoom 1x: content point (40, 40) from the canvas origin.
    const firstX = canvasRect.left + 40
    const firstY = canvasRect.top + 40
    node.dispatch(wheelEvent(-120, { clientX: firstX, clientY: firstY }))
    expect(c.value).toBe(2)

    // Second notch before any repaint, from a DIFFERENT cursor position -
    // geometry is unchanged (no resize happened), so a correct
    // implementation must not re-derive content coords from it.
    const secondX = firstX + 30
    const secondY = firstY + 15
    node.dispatch(wheelEvent(-120, { clientX: secondX, clientY: secondY }))
    expect(c.value).toBe(3)

    binding.restoreAnchor()

    const canvasOffsetX = canvasRect.left - scrollerRect.left + initialScrollLeft
    const canvasOffsetY = canvasRect.top - scrollerRect.top + initialScrollTop
    // The LAST notch's cursor position is what the point should land under.
    const cursorOffsetX = secondX - scrollerRect.left
    const cursorOffsetY = secondY - scrollerRect.top
    const expectedLeft = canvasOffsetX + 40 * c.value - cursorOffsetX
    const expectedTop = canvasOffsetY + 40 * c.value - cursorOffsetY
    expect(node.scrollLeft).toBeCloseTo(expectedLeft, 5)
    expect(node.scrollTop).toBeCloseTo(expectedTop, 5)
  })
})
