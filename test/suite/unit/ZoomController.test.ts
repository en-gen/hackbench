/**
 * `ZoomController`'s wheel accumulation, clamping and anchor math (#651),
 * exercised with no real DOM. No `@theia/core` import anywhere in this
 * file's own graph - see zoom-controller.ts's doc comment on why CI needs
 * that (`npm ci` alone, no `theia/node_modules`).
 */
import { describe, it, expect, vi } from 'vitest'
import { ZoomController } from '../../../theia/extension/src/browser/zoom-controller'

/** Minimal stand-in for the scroll container `bindWheel` listens on, and
 * for the canvas `canvasOf` returns - `rect` is public and mutable so a
 * test can move it BETWEEN the wheel event and `restoreAnchor()`, modelling
 * a layout shift (a sibling reflowing, a scroll clamp) that happens for a
 * reason other than the zoom step itself. */
class FakeNode {
  scrollLeft = 0
  scrollTop = 0
  clientWidth = 400
  clientHeight = 200
  rect: { left: number; top: number }
  private readonly handlers: Array<(e: FakeWheelEvent) => void> = []

  constructor(rect = { left: 0, top: 0 }) {
    this.rect = rect
  }

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
  timeStamp?: number
  deltaMode?: number
  preventDefault: () => void
  prevented: boolean
}

function wheelEvent(
  deltaY: number,
  opts: Partial<
    Pick<FakeWheelEvent, 'ctrlKey' | 'clientX' | 'clientY' | 'timeStamp' | 'deltaMode'>
  > = {},
): FakeWheelEvent {
  const e: FakeWheelEvent = {
    ctrlKey: opts.ctrlKey ?? true,
    deltaY,
    clientX: opts.clientX ?? 0,
    clientY: opts.clientY ?? 0,
    timeStamp: opts.timeStamp,
    deltaMode: opts.deltaMode,
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
      why: 'only ONE crossing happened - the 60px left over stays credit, not a second step',
    },
    { initial: 1, deltas: [-100], expectValue: 2, why: 'negative deltaY zooms in' },
    { initial: 4, deltas: [100], expectValue: 3, why: 'positive deltaY zooms out' },
    {
      initial: 1,
      deltas: [-350],
      expectValue: 4,
      why: 'one EVENT carrying several notches worth of delta steps that many times, capped',
    },
  ])('$why', ({ initial, deltas, expectValue }) => {
    const c = new ZoomController(MAP16_LEVELS, initial)
    const node = new FakeNode()
    bind(c, node)
    for (const d of deltas) node.dispatch(wheelEvent(d))
    expect(c.value).toBe(expectValue)
  })

  it("a multi-step event's leftover credit (not a full 100px) carries to the next event", () => {
    const c = new ZoomController(GFX_LEVELS, 1)
    const node = new FakeNode()
    bind(c, node)
    node.dispatch(wheelEvent(-350)) // 3 steps (1->2->3->4), 50px left over
    expect(c.value).toBe(4)
    node.dispatch(wheelEvent(-80)) // 50 + 80 = 130px: one more step
    expect(c.value).toBe(6)
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

/**
 * `node` and `canvas` are otherwise independent fakes, so `canvas`'s
 * getBoundingClientRect() is wired to move opposite `node.scrollLeft/Top`
 * from here on - the same relationship a real scrolled child has to its
 * scroll container. `canvas.rect` still sets the BASE box, so a test can
 * additionally move it to model a layout shift that has nothing to do
 * with scrolling (see the reflow-absorption test below).
 */
function layout() {
  const node = new FakeNode({ left: 10, top: 5 }) // scroller's own border box
  node.scrollLeft = 50
  node.scrollTop = 20
  const baseScrollLeft = node.scrollLeft
  const baseScrollTop = node.scrollTop
  const canvas = new FakeNode({ left: -21, top: -16 }) // canvas box need not match the scroller's
  const baseRect = canvas.getBoundingClientRect.bind(canvas)
  canvas.getBoundingClientRect = () => {
    const r = baseRect()
    return {
      ...r,
      left: r.left - (node.scrollLeft - baseScrollLeft),
      top: r.top - (node.scrollTop - baseScrollTop),
    }
  }
  return { node, canvas }
}

describe('ZoomController - anchoring', () => {
  it('restores scroll so the same canvas pixel sits under the cursor, within 1px', () => {
    const c = new ZoomController(MAP16_LEVELS, 2) // starts at 2x
    const { node, canvas } = layout()
    const binding = bind(c, node, canvas)
    const canvasRect = canvas.getBoundingClientRect()

    const clientX = canvasRect.left + 100 // 100px into the canvas, at 2x -> content (50, 50)
    const clientY = canvasRect.top + 100
    node.dispatch(wheelEvent(-120, { clientX, clientY }))
    expect(c.value).toBe(3)

    binding.restoreAnchor()

    // Independent check: read the canvas's box back (unchanged in this
    // test - nothing here moves it) and convert the client point back to a
    // canvas-space coordinate at the NEW zoom. It must be (50, 50) again.
    const after = canvas.getBoundingClientRect()
    expect(Math.abs((clientX - after.left) / c.value - 50)).toBeLessThan(1)
    expect(Math.abs((clientY - after.top) / c.value - 50)).toBeLessThan(1)
  })

  it('absorbs a canvas box that moved for a reason OTHER than the zoom step between the wheel event and the repaint', () => {
    // Models Map16's own reflow (#651): the browser column widens with the
    // canvas, its note text re-wraps to fewer lines, and that pulls the
    // canvas wrap - and so the canvas - up the page. restoreAnchor must
    // correct for THAT too, not only for the resize it expects.
    const c = new ZoomController(MAP16_LEVELS, 2)
    const { node, canvas } = layout()
    const binding = bind(c, node, canvas)
    const canvasRect = canvas.getBoundingClientRect()

    const clientX = canvasRect.left + 100
    const clientY = canvasRect.top + 100
    node.dispatch(wheelEvent(-120, { clientX, clientY }))
    expect(c.value).toBe(3)

    // The reflow: the canvas's box moves by an amount that has nothing to
    // do with scroll or zoom, discovered only when restoreAnchor re-reads
    // it.
    canvas.rect = { left: canvasRect.left - 10, top: canvasRect.top + 6 }

    binding.restoreAnchor()

    const after = canvas.getBoundingClientRect()
    expect(Math.abs((clientX - after.left) / c.value - 50)).toBeLessThan(1)
    expect(Math.abs((clientY - after.top) / c.value - 50)).toBeLessThan(1)
  })

  it('produces no anchor at a clamp, so restoreAnchor is a no-op', () => {
    const c = new ZoomController(MAP16_LEVELS, 4) // already at the top
    const { node, canvas } = layout()
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
    const { node, canvas } = layout()
    const binding = bind(c, node, canvas)
    node.dispatch(wheelEvent(-120)) // wheel step to 3x, anchor pending for 3x
    expect(c.value).toBe(3)

    c.step(1) // a ZoomStepper button click: zoom moves again, to 4x

    const before = { scrollLeft: node.scrollLeft, scrollTop: node.scrollTop }
    binding.restoreAnchor() // the pending anchor targeted 3x; current value is 4x
    expect(node.scrollLeft).toBe(before.scrollLeft)
    expect(node.scrollTop).toBe(before.scrollTop)
  })

  it("consecutive notches before a repaint keep the FIRST notch's content point, but the LATEST cursor position", () => {
    const c = new ZoomController(GFX_LEVELS, 1)
    const { node, canvas } = layout()
    const binding = bind(c, node, canvas)
    const canvasRect = canvas.getBoundingClientRect()

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

    const after = canvas.getBoundingClientRect()
    // The FIRST notch's content point (40, 40) must land under the SECOND
    // (latest) notch's client position.
    expect(Math.abs((secondX - after.left) / c.value - 40)).toBeLessThan(1)
    expect(Math.abs((secondY - after.top) / c.value - 40)).toBeLessThan(1)
  })
})

describe('ZoomController.bindWheel - gesture boundaries', () => {
  it.each([
    { gapMs: 100, expected: 3 },
    { gapMs: 1000, expected: 2 },
  ])('leftover credit survives a $gapMs ms gap: $expected', ({ gapMs, expected }) => {
    const c = new ZoomController(MAP16_LEVELS, 2)
    const node = new FakeNode()
    bind(c, node)
    node.dispatch(wheelEvent(-60, { timeStamp: 1000 }))
    node.dispatch(wheelEvent(-60, { timeStamp: 1000 + gapMs }))
    expect(c.value).toBe(expected)
  })

  it('a plain wheel cancels the pending follow-up correction, and so does dispose', () => {
    const cancel = vi.fn()
    vi.stubGlobal(
      'requestAnimationFrame',
      vi.fn(() => 7),
    )
    vi.stubGlobal('cancelAnimationFrame', cancel)
    try {
      const c = new ZoomController(MAP16_LEVELS, 2)
      const node = new FakeNode()
      const binding = bind(c, node)
      node.dispatch(wheelEvent(-100))
      binding.restoreAnchor()
      node.dispatch(wheelEvent(50, { ctrlKey: false }))
      expect(cancel).toHaveBeenCalledWith(7)
      cancel.mockClear()
      node.dispatch(wheelEvent(-100))
      binding.restoreAnchor()
      binding.dispose()
      expect(cancel).toHaveBeenCalledWith(7)
    } finally {
      vi.unstubAllGlobals()
    }
  })
})

describe('ZoomController.bindWheel - per-binding credit', () => {
  it('a partial gesture on one bound node lends no credit to another sharing the controller', () => {
    const c = new ZoomController(GFX_LEVELS, 4)
    const a = new FakeNode()
    const b = new FakeNode()
    bind(c, a)
    bind(c, b)
    a.dispatch(wheelEvent(-60))
    b.dispatch(wheelEvent(-60))
    expect(c.value).toBe(4)
  })
})

describe('ZoomController.bindWheel - delta modes', () => {
  it.each([
    { mode: 'line', deltaMode: 1, deltaY: -3 },
    { mode: 'page', deltaMode: 2, deltaY: -1 },
  ])('one $mode notch takes one step', ({ deltaMode, deltaY }) => {
    const c = new ZoomController(GFX_LEVELS, 4)
    const node = new FakeNode()
    bind(c, node)
    node.dispatch(wheelEvent(deltaY, { deltaMode }))
    expect(c.value).toBe(6)
  })
})

describe('ZoomController - fit mode', () => {
  const MAPS = [1, 2, 3, 4]
  /** A host whose fit value the test moves, like a resizing panel. */
  const host = (fit: number | undefined) => {
    const h = { fit }
    return { h, c: new ZoomController(MAPS, 1, () => h.fit) }
  }

  it('without a fit function there is no fit mode, and enterFit is a no-op', () => {
    const c = new ZoomController(MAPS, 2)
    expect(c.canFit).toBe(false)
    expect(c.fitting).toBe(false)
    c.enterFit()
    expect(c.fitting).toBe(false)
    expect(c.value).toBe(2)
  })

  it.each([0.25, 0.6, 1, 1.37, 2.5, 3.99, 4])('enterFit takes fit value %s', fit => {
    const { c } = host(fit)
    c.enterFit()
    expect(c.fitting).toBe(true)
    expect(c.value).toBe(fit)
  })

  it('refit follows the host while fitting, and notifies only on a change', () => {
    const { h, c } = host(1.5)
    c.enterFit()
    const l = vi.fn()
    c.onDidChange(l)
    c.refit()
    expect(l).not.toHaveBeenCalled()
    h.fit = 0.8
    c.refit()
    expect(c.value).toBe(0.8)
    expect(l).toHaveBeenCalledTimes(1)
  })

  it('an unmeasurable fit (undefined) keeps the last value', () => {
    const { h, c } = host(1.5)
    c.enterFit()
    h.fit = undefined
    c.refit()
    expect(c.value).toBe(1.5)
    expect(c.fitting).toBe(true)
  })

  it.each([
    { fit: 0.4, up: 1, down: undefined },
    { fit: 1.37, up: 2, down: 1 },
    { fit: 2.5, up: 3, down: 2 },
    { fit: 3.99, up: 4, down: 3 },
    { fit: 4, up: undefined, down: 3 },
  ])('from fit $fit, steps go to the next level: up $up, down $down', ({ fit, up, down }) => {
    for (const [dir, want] of [
      [1, up],
      [-1, down],
    ] as const) {
      const { c } = host(fit)
      c.enterFit()
      expect(c.step(dir)).toBe(want !== undefined)
      expect(c.value).toBe(want ?? fit)
      expect(c.fitting).toBe(want === undefined)
    }
  })

  it('a manual step leaves fit mode: refit then keeps the zoom', () => {
    const { h, c } = host(1.37)
    c.enterFit()
    c.step(1)
    h.fit = 3
    c.refit()
    expect(c.value).toBe(2)
  })

  it('Ctrl + wheel from fit leaves fit mode', () => {
    const { h, c } = host(1.37)
    c.enterFit()
    const node = new FakeNode()
    bind(c, node)
    node.dispatch(wheelEvent(-120))
    expect(c.fitting).toBe(false)
    expect(c.value).toBe(2)
    h.fit = 4
    c.refit()
    expect(c.value).toBe(2)
  })

  it('canZoomIn/Out are judged from a fractional fit', () => {
    const { c } = host(0.5)
    c.enterFit()
    expect(c.canZoomOut).toBe(false)
    expect(c.canZoomIn).toBe(true)
  })

  it('actualSize is exactly 1, leaves fit mode, and notifies once', () => {
    const { h, c } = host(2.2)
    c.enterFit()
    const l = vi.fn()
    c.onDidChange(l)
    c.actualSize()
    expect(c.value).toBe(1)
    expect(c.fitting).toBe(false)
    expect(l).toHaveBeenCalledTimes(1)
    h.fit = 3
    c.refit()
    expect(c.value).toBe(1)
  })

  it('actualSize at 1 in fit mode still leaves fit mode, even at the same value', () => {
    const { c } = host(1)
    c.enterFit()
    c.actualSize()
    expect(c.fitting).toBe(false)
  })

  it('actualSize keeps the view centre: the content point there stays put', () => {
    const { c } = host(2)
    c.enterFit()
    const node = new FakeNode({ left: 10, top: 5 })
    node.scrollLeft = 100
    node.scrollTop = 40
    const canvas = new FakeNode()
    // The canvas box moves opposite the scroll, as in a real scroller.
    canvas.getBoundingClientRect = () => ({
      left: 10 - node.scrollLeft,
      top: 5 - node.scrollTop,
      right: 0,
      bottom: 0,
      width: 0,
      height: 0,
    })
    const binding = bind(c, node, canvas)
    const content = { x: (100 + 200) / 2, y: (40 + 100) / 2 } // centre point in content px at 2x
    c.actualSize()
    node.scrollLeft = 0 // the resized canvas clamped the scroll
    node.scrollTop = 0
    binding.restoreAnchor()
    expect(node.scrollLeft + node.clientWidth / 2).toBeCloseTo(content.x, 6)
    expect(node.scrollTop + node.clientHeight / 2).toBeCloseTo(content.y, 6)
  })

  it('actualSize notifies on a fit-flag-only change (zoom already 1)', () => {
    const { c } = host(1)
    c.enterFit()
    const l = vi.fn()
    c.onDidChange(l)
    c.actualSize()
    expect(l).toHaveBeenCalledTimes(1)
  })

  it.each([
    { fit: 3.9995, name: 'canZoomIn' },
    { fit: 1.0005, name: 'canZoomOut' },
  ])('$name and step agree at a fit within EPS of a level ($fit)', ({ fit, name }) => {
    const dir = name === 'canZoomIn' ? 1 : -1
    const { c } = host(fit)
    c.enterFit()
    const can = dir > 0 ? c.canZoomIn : c.canZoomOut
    expect(c.step(dir)).toBe(can)
  })

  it('enterFit with an unmeasurable fit keeps the current zoom', () => {
    const c = new ZoomController(MAPS, 2, () => undefined)
    c.enterFit()
    expect(c.value).toBe(2)
    expect(c.fitting).toBe(true)
  })

  it('actualSize at 1 and not fitting arms no anchor: a later scroll is not undone', () => {
    const c = new ZoomController(MAPS, 1, () => 1)
    const { node, canvas } = layout()
    const binding = bind(c, node, canvas)
    c.actualSize()
    c.actualSize()
    node.scrollLeft = 250 // a plain user scroll after the no-op clicks
    binding.restoreAnchor()
    expect(node.scrollLeft).toBe(250)
  })

  it("one binding's dispose leaves another binding's centre anchor armed", () => {
    const { h, c } = host(2)
    void h
    c.enterFit()
    const a = layout()
    const b = layout()
    const first = bind(c, a.node, a.canvas)
    const second = bind(c, b.node, b.canvas)
    first.dispose()
    b.node.scrollLeft = 100
    c.actualSize()
    b.node.scrollLeft = 0
    second.restoreAnchor()
    expect(b.node.scrollLeft).not.toBe(0)
  })

  describe('centreAnchored (Maps)', () => {
    /** Scroller 400x200 scrolled to (100,40); the canvas moves opposite the scroll. */
    function scroller(c: ZoomController) {
      const node = new FakeNode({ left: 10, top: 5 })
      node.scrollLeft = 100
      node.scrollTop = 40
      const canvas = new FakeNode()
      canvas.getBoundingClientRect = () => ({
        left: 10 - node.scrollLeft,
        top: 5 - node.scrollTop,
        right: 0,
        bottom: 0,
        width: 0,
        height: 0,
      })
      return { node, binding: bind(c, node, canvas) }
    }

    it.each([1, -1] as const)('a button step (dir %i) keeps the centre point', dir => {
      const c = new ZoomController(MAPS, 2)
      c.centreAnchored = true
      const { node, binding } = scroller(c)
      const cx = (node.scrollLeft + node.clientWidth / 2) / 2
      c.step(dir)
      node.scrollLeft = 0
      binding.restoreAnchor()
      expect((node.scrollLeft + node.clientWidth / 2) / c.value).toBeCloseTo(cx, 6)
    })

    it('without the flag a button step leaves the scroll alone', () => {
      const c = new ZoomController(MAPS, 2)
      const { node, binding } = scroller(c)
      c.step(1)
      binding.restoreAnchor()
      expect(node.scrollLeft).toBe(100)
    })

    it('the Fit button anchors; enterFit without the option (a map load) does not', () => {
      for (const anchored of [true, false]) {
        const c = new ZoomController(MAPS, 3, () => 1.5)
        c.centreAnchored = true
        const { node, binding } = scroller(c)
        c.enterFit({ anchored })
        binding.restoreAnchor()
        expect(node.scrollLeft !== 100).toBe(anchored)
      }
    })

    it('a refit on resize is not anchored', () => {
      const h = { fit: 1.5 }
      const c = new ZoomController(MAPS, 1, () => h.fit)
      c.centreAnchored = true
      c.enterFit()
      const { node, binding } = scroller(c)
      h.fit = 1.2
      c.refit()
      binding.restoreAnchor()
      expect(node.scrollLeft).toBe(100)
    })
  })
})
