/**
 * `ZoomController`'s wheel accumulation, clamping and anchor math (#651),
 * exercised with no real DOM: a synthetic node stands in for the scroll
 * container, and synthetic wheel events stand in for the browser's own.
 * `test/suite/support/corpus.ts`'s ROM-free philosophy applies here too -
 * this is pure browser logic and needs neither a ROM nor a real window.
 */
import { describe, it, expect, vi } from 'vitest'
import { ZoomController } from '../../../theia/extension/src/browser/zoom-controller'

/** Minimal stand-in for the scroll container `bindWheel` listens on. */
class FakeScrollNode {
  scrollLeft = 0
  scrollTop = 0
  private readonly handlers: Array<(e: FakeWheelEvent) => void> = []

  constructor(private readonly rect: { left: number; top: number } = { left: 0, top: 0 }) {}

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
  deltaMode: number
  clientX: number
  clientY: number
  preventDefault: () => void
  prevented: boolean
}

function wheelEvent(
  deltaY: number,
  opts: Partial<Pick<FakeWheelEvent, 'ctrlKey' | 'deltaMode' | 'clientX' | 'clientY'>> = {},
): FakeWheelEvent {
  const e: FakeWheelEvent = {
    ctrlKey: opts.ctrlKey ?? true,
    deltaY,
    deltaMode: opts.deltaMode ?? 0,
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
    prevented: false,
    preventDefault(): void {
      e.prevented = true
    },
  }
  return e
}

// Real `bindWheel` takes an HTMLElement; the fake node implements exactly the
// surface it calls (addEventListener/removeEventListener/getBoundingClientRect/
// scrollLeft/scrollTop), so this cast is the intended seam, not a shortcut.
function bind(controller: ZoomController, node: FakeScrollNode) {
  return controller.bindWheel(node as unknown as HTMLElement)
}

const MAP16_LEVELS = [1, 2, 3, 4]
const GFX_LEVELS = [1, 2, 3, 4, 6, 8]

describe('ZoomController.step/set - clamping', () => {
  it('clamps at the top level and stops firing once there', () => {
    const c = new ZoomController(MAP16_LEVELS, 4)
    const seen: number[] = []
    c.onDidChange(v => seen.push(v))
    c.step(1)
    c.step(1)
    expect(c.value).toBe(4)
    expect(c.canZoomIn).toBe(false)
    expect(seen).toEqual([]) // already at the top: never fired
  })

  it('clamps at the bottom level and stops firing once there', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const seen: number[] = []
    c.onDidChange(v => seen.push(v))
    c.step(-1)
    expect(c.value).toBe(1)
    expect(c.canZoomOut).toBe(false)
    expect(seen).toEqual([])
  })

  it('steps one level at a time in either direction', () => {
    const c = new ZoomController(MAP16_LEVELS, 2)
    c.step(1)
    expect(c.value).toBe(3)
    c.step(-1)
    c.step(-1)
    expect(c.value).toBe(1)
  })

  it('set() ignores a value outside the level list', () => {
    const c = new ZoomController(MAP16_LEVELS, 2)
    const seen: number[] = []
    c.onDidChange(v => seen.push(v))
    c.set(5)
    expect(c.value).toBe(2)
    expect(seen).toEqual([])
  })

  it('set() jumps straight to a valid level and fires once', () => {
    const c = new ZoomController(GFX_LEVELS, 1)
    const seen: number[] = []
    c.onDidChange(v => seen.push(v))
    c.set(8)
    expect(c.value).toBe(8)
    expect(seen).toEqual([8])
  })

  it('falls back to the first level when the initial value is not one of them', () => {
    const c = new ZoomController(MAP16_LEVELS, 99)
    expect(c.value).toBe(1)
  })
})

describe('ZoomController.bindWheel - threshold and direction', () => {
  it('does not step until 100px of delta has accumulated', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeScrollNode()
    bind(c, node)
    node.dispatch(wheelEvent(-40))
    node.dispatch(wheelEvent(-40))
    expect(c.value).toBe(1) // 80px: below the 100px threshold
  })

  it('steps once as soon as the accumulated delta reaches 100px', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeScrollNode()
    bind(c, node)
    node.dispatch(wheelEvent(-40))
    node.dispatch(wheelEvent(-40))
    node.dispatch(wheelEvent(-40)) // 120px total
    expect(c.value).toBe(2)
  })

  it('negative deltaY (scroll up / away from the user) zooms in', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeScrollNode()
    bind(c, node)
    node.dispatch(wheelEvent(-100))
    expect(c.value).toBe(2)
  })

  it('positive deltaY (scroll down / toward the user) zooms out', () => {
    const c = new ZoomController(MAP16_LEVELS, 4)
    const node = new FakeScrollNode()
    bind(c, node)
    node.dispatch(wheelEvent(100))
    expect(c.value).toBe(3)
  })

  it('resets the accumulator on a direction reversal, rather than carrying stale credit across', () => {
    const c = new ZoomController(MAP16_LEVELS, 2)
    const node = new FakeScrollNode()
    bind(c, node)
    node.dispatch(wheelEvent(-60)) // zoom-in credit: 60px
    node.dispatch(wheelEvent(60)) // reversal: resets, then 60px zoom-out credit
    expect(c.value).toBe(2) // neither direction has reached 100px yet
    node.dispatch(wheelEvent(50)) // zoom-out credit: 110px total since the reversal
    expect(c.value).toBe(1) // one zoom-OUT step, not a zoom-in step from stale credit
  })

  it('a large single delta (a fast pinch) can clear more than one threshold at once', () => {
    const c = new ZoomController(GFX_LEVELS, 1)
    const node = new FakeScrollNode()
    bind(c, node)
    node.dispatch(wheelEvent(-350)) // 3 whole steps, 50px left over
    expect(c.value).toBe(4)
  })

  it('never steps past the clamp even when the delta would cross several more thresholds', () => {
    const c = new ZoomController(MAP16_LEVELS, 3)
    const node = new FakeScrollNode()
    bind(c, node)
    node.dispatch(wheelEvent(-1000))
    expect(c.value).toBe(4)
  })
})

describe('ZoomController.bindWheel - deltaMode normalization', () => {
  it('DOM_DELTA_LINE (Firefox) is scaled to pixels before the threshold applies', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeScrollNode()
    bind(c, node)
    // 6 lines * 16px/line = 96px: still under threshold
    node.dispatch(wheelEvent(-6, { deltaMode: 1 }))
    expect(c.value).toBe(1)
    // one more line reaches 112px and crosses it
    node.dispatch(wheelEvent(-1, { deltaMode: 1 }))
    expect(c.value).toBe(2)
  })

  it('DOM_DELTA_PAGE is scaled to pixels too', () => {
    const c = new ZoomController(GFX_LEVELS, 1)
    const node = new FakeScrollNode()
    bind(c, node)
    node.dispatch(wheelEvent(-1, { deltaMode: 2 })) // 800px: clamps at the top
    expect(c.value).toBe(8)
  })
})

describe('ZoomController.bindWheel - ctrlKey gate', () => {
  it('ignores a plain wheel and does not preventDefault it', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeScrollNode()
    bind(c, node)
    const e = wheelEvent(-500, { ctrlKey: false })
    node.dispatch(e)
    expect(c.value).toBe(1)
    expect(e.prevented).toBe(false)
  })

  it('preventDefault()s a Ctrl + wheel event even below the step threshold', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeScrollNode()
    bind(c, node)
    const e = wheelEvent(-10, { ctrlKey: true })
    node.dispatch(e)
    expect(e.prevented).toBe(true)
    expect(c.value).toBe(1) // too small to step; prevention does not imply a step
  })

  it('disposing the binding removes the listener', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeScrollNode()
    const disposable = bind(c, node)
    expect(node.listenerCount).toBe(1)
    disposable.dispose()
    expect(node.listenerCount).toBe(0)
    node.dispatch(wheelEvent(-500))
    expect(c.value).toBe(1) // no listener left to react
  })
})

describe('ZoomController - anchoring', () => {
  it('captures a content-space anchor on a wheel-driven step, resolvable to within 1px of the target scroll position', () => {
    const c = new ZoomController(MAP16_LEVELS, 2) // starts at 2x
    const node = new FakeScrollNode({ left: 10, top: 5 })
    node.scrollLeft = 50
    node.scrollTop = 20
    bind(c, node)

    // Cursor at client (110, 105) => offset (100, 100) within the node.
    node.dispatch(wheelEvent(-120, { clientX: 110, clientY: 105 }))
    expect(c.value).toBe(3) // stepped from 2x to 3x

    const anchor = c.takePendingAnchor(node as unknown as HTMLElement)
    expect(anchor).toBeDefined()
    // Content point under the cursor at the OLD zoom (2x): (50+100)/2, (20+100)/2
    expect(anchor!.contentX).toBeCloseTo(75, 5)
    expect(anchor!.contentY).toBeCloseTo(60, 5)
    expect(anchor!.offsetX).toBe(100)
    expect(anchor!.offsetY).toBe(100)

    // What the widget derives from it at the NEW zoom (3x) keeps the same
    // content pixel under the same screen point, to within 1px.
    const newScrollLeft = anchor!.contentX * c.value - anchor!.offsetX
    const newScrollTop = anchor!.contentY * c.value - anchor!.offsetY
    expect(Math.abs(newScrollLeft - 125)).toBeLessThan(1)
    expect(Math.abs(newScrollTop - 80)).toBeLessThan(1)
  })

  it('the anchor is consumed exactly once', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeScrollNode()
    bind(c, node)
    node.dispatch(wheelEvent(-100))
    expect(c.takePendingAnchor(node as unknown as HTMLElement)).toBeDefined()
    expect(c.takePendingAnchor(node as unknown as HTMLElement)).toBeUndefined()
  })

  it('a shared controller only lets the node that actually scrolled consume the anchor', () => {
    // Models the GFX sheet: several open sheets share one ZoomController,
    // each binding its OWN node - see gfx-view-widget.tsx.
    const c = new ZoomController(GFX_LEVELS, 1)
    const nodeA = new FakeScrollNode()
    const nodeB = new FakeScrollNode()
    bind(c, nodeA)
    bind(c, nodeB)
    nodeA.dispatch(wheelEvent(-100))
    expect(c.takePendingAnchor(nodeB as unknown as HTMLElement)).toBeUndefined()
    expect(c.takePendingAnchor(nodeA as unknown as HTMLElement)).toBeDefined()
  })

  it('a direct step()/set() call (not wheel-driven) leaves no pending anchor', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const node = new FakeScrollNode()
    c.step(1)
    expect(c.takePendingAnchor(node as unknown as HTMLElement)).toBeUndefined()
  })
})

describe('ZoomController.onDidChange', () => {
  it('fires with the new value on every accepted change', () => {
    const c = new ZoomController(MAP16_LEVELS, 1)
    const listener = vi.fn()
    c.onDidChange(listener)
    c.step(1)
    c.set(4)
    expect(listener).toHaveBeenNthCalledWith(1, 2)
    expect(listener).toHaveBeenNthCalledWith(2, 4)
  })
})
