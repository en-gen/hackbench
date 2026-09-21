/**
 * Minimal in-memory OverlayContext mock for drawing-primitive tests.
 *
 * Records every draw call as a tagged event. Tests assert over the
 * resulting event log rather than the actual pixels produced, which
 * keeps them deterministic and fast.
 */

import type { OverlayContext, OverlayGradient } from '../../../../src/rom/model/OverlayContext'

export type CanvasOp =
  | { op: 'save' }
  | { op: 'restore' }
  | { op: 'beginPath' }
  | { op: 'closePath' }
  | { op: 'moveTo'; x: number; y: number }
  | { op: 'lineTo'; x: number; y: number }
  | { op: 'stroke' }
  | { op: 'fill' }
  | { op: 'setLineDash'; segs: number[] }
  | { op: 'fillRect'; x: number; y: number; w: number; h: number; fillStyle: string }
  | {
      op: 'strokeRect'
      x: number
      y: number
      w: number
      h: number
      strokeStyle: string
      lineWidth: number
      dash: number[]
    }
  | { op: 'ellipse'; cx: number; cy: number; rx: number; ry: number }
  | {
      op: 'arc'
      cx: number
      cy: number
      r: number
      startAngle: number
      endAngle: number
      anticlockwise: boolean
    }
  | { op: 'createLinearGradient'; id: number; x0: number; y0: number; x1: number; y1: number }
  | { op: 'addColorStop'; id: number; offset: number; color: string }

export interface MockCtx extends OverlayContext {
  fillStyle: string | OverlayGradient
  strokeStyle: string | OverlayGradient
  lineWidth: number
  events: CanvasOp[]
  reset(): void
}

export function makeMockCtx(): MockCtx {
  const state = {
    fillStyle: '#000' as string | OverlayGradient,
    strokeStyle: '#000' as string | OverlayGradient,
    lineWidth: 1,
    dash: [] as number[],
  }
  const events: CanvasOp[] = []
  let gradientId = 0
  const styleToString = (v: string | OverlayGradient): string =>
    typeof v === 'string' ? v : `gradient#${(v as { __id: number }).__id}`
  const ctx: MockCtx = {
    get fillStyle() {
      return state.fillStyle
    },
    set fillStyle(v) {
      state.fillStyle = v
    },
    get strokeStyle() {
      return state.strokeStyle
    },
    set strokeStyle(v) {
      state.strokeStyle = v
    },
    get lineWidth() {
      return state.lineWidth
    },
    set lineWidth(v) {
      state.lineWidth = v
    },

    events,
    reset: () => {
      events.length = 0
    },

    save() {
      events.push({ op: 'save' })
    },
    restore() {
      events.push({ op: 'restore' })
    },
    beginPath() {
      events.push({ op: 'beginPath' })
    },
    closePath() {
      events.push({ op: 'closePath' })
    },
    moveTo(x, y) {
      events.push({ op: 'moveTo', x, y })
    },
    lineTo(x, y) {
      events.push({ op: 'lineTo', x, y })
    },
    stroke() {
      events.push({ op: 'stroke' })
    },
    fill() {
      events.push({ op: 'fill' })
    },
    setLineDash(segs) {
      state.dash = [...segs]
      events.push({ op: 'setLineDash', segs: [...segs] })
    },
    fillRect(x, y, w, h) {
      events.push({ op: 'fillRect', x, y, w, h, fillStyle: styleToString(state.fillStyle) })
    },
    strokeRect(x, y, w, h) {
      events.push({
        op: 'strokeRect',
        x,
        y,
        w,
        h,
        strokeStyle: styleToString(state.strokeStyle),
        lineWidth: state.lineWidth,
        dash: [...state.dash],
      })
    },
    ellipse(cx, cy, rx, ry) {
      events.push({ op: 'ellipse', cx, cy, rx, ry })
    },
    arc(cx, cy, r, startAngle, endAngle, anticlockwise = false) {
      events.push({ op: 'arc', cx, cy, r, startAngle, endAngle, anticlockwise })
    },
    createLinearGradient(x0, y0, x1, y1): OverlayGradient {
      const id = ++gradientId
      events.push({ op: 'createLinearGradient', id, x0, y0, x1, y1 })
      const grad: OverlayGradient & { __id: number } = {
        __id: id,
        addColorStop(offset, color) {
          events.push({ op: 'addColorStop', id, offset, color })
        },
      }
      return grad
    },
  }
  return ctx
}

/** Count events matching a predicate. */
export function countEvents(events: CanvasOp[], pred: (e: CanvasOp) => boolean): number {
  return events.reduce((n, e) => n + (pred(e) ? 1 : 0), 0)
}
