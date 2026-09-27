/**
 * Drives an on-screen zoom control from Ctrl + wheel (#651).
 *
 * Plain TypeScript, no Theia or React import: `ZoomStepper` renders it,
 * `Map16ViewWidget` and `GfxViewWidget` bind it to their scroll container,
 * and `ZoomController.test.ts` exercises it with no DOM at all.
 *
 * One mouse wheel notch reports `deltaY` around 100-120 (`deltaMode` LINE on
 * Firefox, PIXEL elsewhere), so `WHEEL_STEP_PX` treats 100 accumulated
 * pixels as one step. A touchpad pinch sends a stream of small deltas
 * instead of one big one, so accumulating rather than stepping per event is
 * what keeps a pinch from racing straight to the clamp.
 */
import { Disposable, Emitter } from '@theia/core/lib/common'

/** One wheel notch, normalized across browsers. */
const WHEEL_STEP_PX = 100
/** DOM_DELTA_LINE / DOM_DELTA_PAGE: Firefox reports lines, not pixels. */
const LINE_HEIGHT_PX = 16
const PAGE_HEIGHT_PX = 800

/**
 * A point to keep fixed under the cursor across a zoom change, captured in
 * CONTENT space (independent of zoom) plus the cursor's own offset within
 * the scroll node. The widget re-derives the new scroll position from these
 * once it has repainted at the new zoom - see `takePendingAnchor`.
 */
export interface ZoomAnchor {
  readonly contentX: number
  readonly contentY: number
  readonly offsetX: number
  readonly offsetY: number
}

/**
 * The controller keeps the scroll NODE alongside the anchor it belongs to.
 * A controller shared by several open sheets (GFX, #651) gets one
 * `bindWheel` call per sheet, so every one of them fires `onDidChange` and
 * asks for the anchor; only the sheet whose own node matches actually
 * scrolled, so it is the only one allowed to consume it.
 */
interface PendingAnchor extends ZoomAnchor {
  readonly node: HTMLElement
}

function pixelDelta(e: WheelEvent): number {
  switch (e.deltaMode) {
    case 1 /* DOM_DELTA_LINE */:
      return e.deltaY * LINE_HEIGHT_PX
    case 2 /* DOM_DELTA_PAGE */:
      return e.deltaY * PAGE_HEIGHT_PX
    default:
      return e.deltaY
  }
}

export class ZoomController {
  private readonly changeEmitter = new Emitter<number>()
  private index: number
  /** Accumulated pixels toward the next step, always same-signed as `wheelDir`. */
  private wheelAccum = 0
  private wheelDir: -1 | 0 | 1 = 0
  private pendingAnchor: PendingAnchor | undefined

  constructor(
    private readonly levels: readonly number[],
    initial: number,
  ) {
    const i = levels.indexOf(initial)
    this.index = i >= 0 ? i : 0
  }

  get value(): number {
    return this.levels[this.index]!
  }

  get onDidChange() {
    return this.changeEmitter.event
  }

  get canZoomIn(): boolean {
    return this.index < this.levels.length - 1
  }

  get canZoomOut(): boolean {
    return this.index > 0
  }

  step(dir: 1 | -1): void {
    const next = Math.min(this.levels.length - 1, Math.max(0, this.index + dir))
    if (next === this.index) return
    this.index = next
    this.changeEmitter.fire(this.value)
  }

  set(value: number): void {
    const i = this.levels.indexOf(value)
    if (i < 0 || i === this.index) return
    this.index = i
    this.changeEmitter.fire(this.value)
  }

  /** Consumed once by the widget owning `node` after it repaints at the new
   * zoom, so a step never applies twice, a non-wheel-driven change never
   * applies at all, and - when several sheets share one controller - only
   * the sheet actually under the cursor moves. */
  takePendingAnchor(node: HTMLElement): ZoomAnchor | undefined {
    if (!this.pendingAnchor || this.pendingAnchor.node !== node) return undefined
    const anchor = this.pendingAnchor
    this.pendingAnchor = undefined
    return anchor
  }

  /**
   * Ctrl + wheel over `node` (the view's own scroll container) steps this
   * controller and preventDefault's, so the page never zooms. Plain wheel is
   * left alone - untouched and not preventDefault'd - so the container keeps
   * scrolling normally.
   */
  bindWheel(node: HTMLElement): Disposable {
    const listener = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      const delta = pixelDelta(e)
      const dir: -1 | 0 | 1 = delta < 0 ? 1 : delta > 0 ? -1 : 0
      if (dir === 0) return
      // A direction reversal starts a fresh accumulation - otherwise a
      // scroll-out-then-in near the threshold could fire from stale credit
      // built up in the OTHER direction.
      if (dir !== this.wheelDir) {
        this.wheelDir = dir
        this.wheelAccum = 0
      }
      this.wheelAccum += Math.abs(delta)
      if (this.wheelAccum < WHEEL_STEP_PX) return

      const zoomBefore = this.value
      const rect = node.getBoundingClientRect()
      const offsetX = e.clientX - rect.left
      const offsetY = e.clientY - rect.top
      const anchor: PendingAnchor = {
        node,
        contentX: (node.scrollLeft + offsetX) / zoomBefore,
        contentY: (node.scrollTop + offsetY) / zoomBefore,
        offsetX,
        offsetY,
      }

      // A single large delta (a fast pinch) can clear more than one
      // threshold at once; step once per threshold cleared, clamping as
      // `step` already does.
      while (this.wheelAccum >= WHEEL_STEP_PX) {
        this.wheelAccum -= WHEEL_STEP_PX
        this.step(dir)
      }
      if (this.value !== zoomBefore) this.pendingAnchor = anchor
    }
    node.addEventListener('wheel', listener, { passive: false })
    return Disposable.create(() => node.removeEventListener('wheel', listener))
  }
}
