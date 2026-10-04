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
/** Pixels per deltaY unit by `deltaMode`: pixel, line, page. */
const DELTA_MODE_PX = [1, WHEEL_STEP_PX / 3, WHEEL_STEP_PX]
/** A pause this long ends a wheel gesture. */
const WHEEL_IDLE_MS = 400
/** Levels closer than this to the zoom count as the zoom itself. */
const EPS = 0.001

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
  /** Any positive number: a fit value or 100% need not be one of `levels`. */
  private zoom: number
  private fit = false
  /**
   * Maps only (#526): every button-driven zoom keeps the view centre fixed.
   * Off, buttons leave the scroll position alone, as GFX and Map16 do. Needs
   * a wheel binding, whose `restoreAnchor` the host calls after its commit.
   */
  centreAnchored = false
  /** Set by `bindWheel`: keeps the view centre fixed across a jump to `target`. */
  private anchorCentre: ((target: number) => void) | undefined

  /**
   * `fitZoom`, when given, enables fit mode (#526): the host's own "what zoom
   * fits the view" - undefined while the view cannot be measured. It is the
   * host's formula, so a second one never drifts from the load-time fit.
   */
  constructor(
    private readonly levels: readonly number[],
    initial: number,
    private readonly fitZoom?: () => number | undefined,
  ) {
    const i = levels.indexOf(initial)
    this.zoom = levels[i >= 0 ? i : 0]!
  }

  get value(): number {
    return this.zoom
  }

  /** Whether the host supplied a fit function. */
  get canFit(): boolean {
    return this.fitZoom !== undefined
  }

  /** True while the zoom tracks the host's fit value. */
  get fitting(): boolean {
    return this.fit
  }

  get canZoomIn(): boolean {
    return this.levels.some(l => l > this.zoom + EPS)
  }

  get canZoomOut(): boolean {
    return this.levels.some(l => l < this.zoom - EPS)
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

  private set(value: number, fit: boolean): boolean {
    const moved = Math.abs(value - this.zoom) > EPS || fit !== this.fit
    this.zoom = value
    this.fit = fit
    if (moved) for (const l of [...this.listeners]) l(this.value)
    return moved
  }

  /** Starts (or resumes) fit mode. A no-op without a fit function. */
  enterFit(opts?: { anchored?: boolean }): void {
    if (!this.fitZoom) return
    const target = this.fitZoom() ?? this.zoom
    // `anchored` is for the Fit button; a map load (a new strip) must not anchor.
    if (opts?.anchored && this.centreAnchored && Math.abs(target - this.zoom) > EPS) {
      this.anchorCentre?.(target)
    }
    this.set(target, true)
  }

  /** The host reports its view resized: follows the fit value while fitting. */
  refit(): void {
    if (!this.fit || !this.fitZoom) return
    const f = this.fitZoom()
    if (f !== undefined) this.set(f, true)
  }

  /** Exactly 100%, anchored on the view centre once a wheel binding exists. */
  actualSize(): void {
    // Armed only for a real jump: a stale anchor would snap a later scroll back.
    if (this.fit || Math.abs(1 - this.zoom) > EPS) this.anchorCentre?.(1)
    this.set(1, false)
  }

  /**
   * One level in `dir`, clamped; from a fractional zoom (fit, 100% outside
   * `levels`) that is the nearest level above or below it. Leaves fit mode
   * only if it moves. Returns whether the value actually moved.
   */
  step(dir: 1 | -1): boolean {
    const next =
      dir > 0
        ? this.levels.find(l => l > this.zoom + EPS)
        : [...this.levels].reverse().find(l => l < this.zoom - EPS)
    if (next === undefined) return false
    if (this.centreAnchored) this.anchorCentre?.(next)
    return this.set(next, false)
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
      // Non-pixel deltas: a notch is 3 lines, or 1 page (Windows "one
      // screen at a time"), so either still takes one step.
      accum += Math.abs(e.deltaY) * (DELTA_MODE_PX[e.deltaMode] ?? 1)
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

    const arm = (target: number): void => {
      const canvas = canvasOf()
      if (!canvas) return
      const rect = canvas.getBoundingClientRect()
      const box = node.getBoundingClientRect()
      const clientX = box.left + node.clientWidth / 2
      const clientY = box.top + node.clientHeight / 2
      pending = {
        contentX: (clientX - rect.left) / this.value,
        contentY: (clientY - rect.top) / this.value,
        clientX,
        clientY,
        zoom: target,
      }
    }

    this.anchorCentre = arm

    return {
      dispose: () => {
        cancelFollowUp()
        if (this.anchorCentre === arm) this.anchorCentre = undefined
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
