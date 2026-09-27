/**
 * Drives an on-screen zoom control from Ctrl + wheel (#651).
 *
 * `onDidChange`'s signature is a subset of Theia's `Event<T>` and the
 * returned object structurally matches Theia's `Disposable`, so this still
 * slots into `toDispose.push(...)` without importing `@theia/core` - which
 * matters because `ZoomController.test.ts` runs in CI with only `npm ci`
 * (no `theia/node_modules`, see `test:unit`'s corpus-free split).
 */

/** deltaY per wheel notch in this app's one target, Chromium/Electron. */
const WHEEL_STEP_PX = 100

export interface Disposable {
  dispose(): void
}

export interface WheelBinding extends Disposable {
  /**
   * Applies the anchor from the last wheel-driven step, once the widget has
   * resized its canvas for the new zoom. A no-op with nothing pending, or
   * if the zoom has moved since the step (another wheel binding, a button)
   * - the pending anchor is for a zoom level that is no longer current.
   */
  restoreAnchor(): void
}

/** Keeps one content pixel under the cursor across a zoom change. Captured
 * in the scroll container's own coordinate space, not the controller's -
 * see `bindWheel`. */
interface PendingAnchor {
  readonly contentX: number
  readonly contentY: number
  readonly canvasOffsetX: number
  readonly canvasOffsetY: number
  readonly cursorOffsetX: number
  readonly cursorOffsetY: number
  readonly zoom: number
}

export class ZoomController implements Disposable {
  private readonly listeners: Array<(value: number) => void> = []
  private index: number
  /** Toward the next step; same sign as the wheel direction it is tracking,
   * reset on a direction reversal so stale credit never carries across. */
  private accum = 0
  private sign: -1 | 0 | 1 = 0

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

  get canZoomIn(): boolean {
    return this.index < this.levels.length - 1
  }

  get canZoomOut(): boolean {
    return this.index > 0
  }

  readonly onDidChange = (listener: (value: number) => void): Disposable => {
    this.listeners.push(listener)
    return {
      dispose: () => {
        const i = this.listeners.indexOf(listener)
        if (i >= 0) this.listeners.splice(i, 1)
      },
    }
  }

  dispose(): void {
    this.listeners.length = 0
  }

  /** One level in `dir`, clamped. Returns whether the value actually moved. */
  step(dir: 1 | -1): boolean {
    const next = Math.min(this.levels.length - 1, Math.max(0, this.index + dir))
    if (next === this.index) return false
    this.index = next
    for (const l of [...this.listeners]) l(this.value)
    return true
  }

  /**
   * Ctrl + wheel over `node` (the view's own scroll container) steps this
   * controller and preventDefault's; plain wheel is untouched. `canvasOf`
   * locates the bitmap being zoomed, so the anchor is measured against the
   * CANVAS's own box rather than the scroll container's padded or bordered
   * one, which would otherwise drift by exactly that padding/border.
   */
  bindWheel(node: HTMLElement, canvasOf: () => HTMLElement | null): WheelBinding {
    let pending: PendingAnchor | undefined

    const listener = (e: WheelEvent): void => {
      if (!e.ctrlKey) return
      e.preventDefault()
      if (e.deltaY === 0) return
      const dir: -1 | 1 = e.deltaY < 0 ? 1 : -1
      if (dir !== this.sign) {
        this.sign = dir
        this.accum = 0
      }
      this.accum += Math.abs(e.deltaY)
      if (this.accum < WHEEL_STEP_PX) return
      this.accum = 0 // one notch is one step; any remainder is discarded

      const zoomBefore = this.value
      const scrollerRect = node.getBoundingClientRect()
      const cursorOffsetX = e.clientX - scrollerRect.left
      const cursorOffsetY = e.clientY - scrollerRect.top

      // A burst of notches faster than the widget repaints keeps the FIRST
      // notch's content point: recomputing it here would read geometry an
      // earlier step in this burst already committed to but the DOM has not
      // caught up with yet (the canvas has not resized).
      let contentX = pending?.contentX
      let contentY = pending?.contentY
      let canvasOffsetX = pending?.canvasOffsetX
      let canvasOffsetY = pending?.canvasOffsetY
      if (contentX === undefined) {
        const canvas = canvasOf()
        if (canvas) {
          const canvasRect = canvas.getBoundingClientRect()
          contentX = (e.clientX - canvasRect.left) / zoomBefore
          contentY = (e.clientY - canvasRect.top) / zoomBefore
          canvasOffsetX = canvasRect.left - scrollerRect.left + node.scrollLeft
          canvasOffsetY = canvasRect.top - scrollerRect.top + node.scrollTop
        }
      }

      if (!this.step(dir)) return // clamped: `pending`, if any, is still valid as-is

      pending =
        contentX === undefined || canvasOffsetX === undefined
          ? undefined // nothing to anchor against (canvas not painted yet)
          : {
              contentX,
              contentY: contentY!,
              canvasOffsetX,
              canvasOffsetY: canvasOffsetY!,
              cursorOffsetX,
              cursorOffsetY,
              zoom: this.value,
            }
    }
    node.addEventListener('wheel', listener, { passive: false })

    return {
      dispose: () => node.removeEventListener('wheel', listener),
      restoreAnchor: () => {
        const anchor = pending
        pending = undefined
        if (!anchor || anchor.zoom !== this.value) return
        node.scrollLeft =
          anchor.canvasOffsetX + anchor.contentX * anchor.zoom - anchor.cursorOffsetX
        node.scrollTop = anchor.canvasOffsetY + anchor.contentY * anchor.zoom - anchor.cursorOffsetY
      },
    }
  }
}
