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
/** A pause this long ends a wheel gesture. */
const WHEEL_IDLE_MS = 400

export interface Disposable {
  dispose(): void
}

export interface WheelBinding extends Disposable {
  /**
   * Applies the anchor from the last wheel-driven step, once the widget has
   * resized its canvas for the new zoom. Re-reads the canvas's CURRENT box
   * rather than trusting anything measured at wheel time, so it corrects
   * for the canvas having moved for ANY reason since - a scroll clamp, or a
   * sibling reflowing (Map16's browser column widens with the canvas and
   * its note text re-wraps, #651) - not only the zoom step itself. A no-op
   * with nothing pending, or if the zoom has moved since the step (another
   * wheel binding, a button) - the pending anchor is for a zoom level that
   * is no longer current.
   */
  restoreAnchor(): void
}

/** One content pixel to keep under the cursor across a zoom change. */
interface PendingAnchor {
  readonly contentX: number
  readonly contentY: number
  readonly clientX: number
  readonly clientY: number
  readonly zoom: number
}

export class ZoomController implements Disposable {
  private readonly listeners: Array<(value: number) => void> = []
  private index: number

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
   * one.
   */
  bindWheel(node: HTMLElement, canvasOf: () => HTMLElement | null): WheelBinding {
    let pending: PendingAnchor | undefined
    // Per binding, not per controller: GFX sheets share one controller, and a
    // partial gesture on one sheet must not lend credit to another.
    let accum = 0
    let sign: -1 | 0 | 1 = 0
    let lastWheel = -Infinity
    let followUp: number | undefined
    const cancelFollowUp = (): void => {
      if (followUp !== undefined) cancelAnimationFrame(followUp)
      followUp = undefined
    }

    const listener = (e: WheelEvent): void => {
      // A plain scroll landing in the follow-up's frame (Ctrl released
      // mid-spin) must not be yanked back to the anchor.
      if (!e.ctrlKey) return cancelFollowUp()
      e.preventDefault()
      if (e.deltaY === 0) return
      const dir: -1 | 1 = e.deltaY < 0 ? 1 : -1
      // Leftover credit from a gesture that ended is not part of this one.
      if (e.timeStamp - lastWheel > WHEEL_IDLE_MS) accum = 0
      lastWheel = e.timeStamp
      if (dir !== sign) {
        sign = dir
        accum = 0
      }
      accum += Math.abs(e.deltaY)
      // One physical notch is ~100-120px and is one step; a single EVENT
      // can still carry several notches' worth (a fast spin, or a huge
      // synthetic delta) and steps that many times, capped by the clamp.
      // The sub-100 remainder is kept, not discarded, so it still counts
      // toward the next event.
      const steps = Math.floor(accum / WHEEL_STEP_PX)
      if (steps === 0) return
      accum -= steps * WHEEL_STEP_PX

      const zoomBefore = this.value

      // A burst of notches faster than the widget repaints keeps the FIRST
      // notch's content point (recomputing it from CURRENT geometry here
      // would read a canvas that has not resized for the earlier steps in
      // this burst yet) but always the LATEST notch's cursor position.
      let contentX = pending?.contentX
      let contentY = pending?.contentY
      if (contentX === undefined) {
        const canvas = canvasOf()
        if (canvas) {
          const rect = canvas.getBoundingClientRect()
          contentX = (e.clientX - rect.left) / zoomBefore
          contentY = (e.clientY - rect.top) / zoomBefore
        }
      }

      let moved = false
      for (let i = 0; i < steps; i++) if (this.step(dir)) moved = true
      if (!moved) return // fully clamped this event: `pending`, if any, is still valid as-is

      pending =
        contentX === undefined
          ? undefined // nothing to anchor against (canvas not painted yet)
          : {
              contentX,
              contentY: contentY!,
              clientX: e.clientX,
              clientY: e.clientY,
              zoom: this.value,
            }
    }
    node.addEventListener('wheel', listener, { passive: false })

    // Re-measures the canvas's CURRENT box rather than trusting anything
    // from wheel time, so it corrects for the canvas having moved for ANY
    // reason - a scroll clamp, or a sibling reflowing (Map16's browser
    // column widens with the canvas, #651) - not only the resize the step
    // itself caused.
    const apply = (anchor: PendingAnchor): void => {
      const canvas = canvasOf()
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      node.scrollLeft += rect.left - (anchor.clientX - anchor.contentX * anchor.zoom)
      node.scrollTop += rect.top - (anchor.clientY - anchor.contentY * anchor.zoom)
    }

    return {
      dispose: () => {
        cancelFollowUp()
        node.removeEventListener('wheel', listener)
      },
      restoreAnchor: () => {
        const anchor = pending
        pending = undefined
        if (!anchor || anchor.zoom !== this.value) return
        apply(anchor)
        // The widget's OWN re-render (the indicator's new text, a toolbar
        // that reflows with it) can still commit and shift the canvas
        // again on the SAME frame, after this synchronous correction -
        // measured on the GFX sheet, where the correct scroll value was
        // set and then overwritten before the next paint. One more
        // correction next frame catches that; skipped if a newer step has
        // since taken over (`this.value` no longer matches). Guarded for
        // `ZoomController.test.ts`, which runs with no DOM/rAF at all.
        cancelFollowUp()
        if (typeof requestAnimationFrame === 'function') {
          followUp = requestAnimationFrame(() => {
            followUp = undefined
            if (anchor.zoom === this.value) apply(anchor)
          })
        }
      },
    }
  }
}
