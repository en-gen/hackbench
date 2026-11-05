/**
 * #1097: a sprite that uploads colors to CGRAM while it runs (the Magikoopa's teleport fade, SMWDisX
 * bank_01.asm:8715-8755 and CODE_01C028) was drawn with the writes of its FIRST drawn pass, which can come before
 * any upload, so the level's own row showed. The view now draws the colors CGRAM holds at the end of the 64-pass
 * run and marks the picture unverified when those were still changing or the sprite only started at the end.
 * Synthetic (CI has no ROM): runs are built here with invented colors, no sprite id, no ROM value. What is asserted
 * is which writes the view takes, that columns the upload leaves alone keep the level's colors, and when it says so.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'
import type {
  PassResult,
  SpriteModel,
  SpritePart,
} from '../../../src/rom/sprites/interp/SpriteRunner'
import {
  drawSprites,
  modelResult,
  type SpriteDrawer,
} from '../../../theia/extension/src/node/map-sprites'
import { COLORS } from '../support/mapInputs'

const ROW = 15 * 16
const PASSES = 64
/** Eight invented colors for CGRAM $F0..$F7, distinct per rung `k` and per column. */
const rung = (k: number, cols = 8) => Array.from({ length: cols }, (_, c) => ({ index: ROW + c, bgr555: 0x0421 * (k + 1) + c * 3 })) // prettier-ignore
const part = (): SpritePart => ({ oam: 0, char: 0, size: 8, palette: 15, priority: 2, flipX: false, flipY: false, dx: 0, dy: 0, attr: 0, ox: 0, oy: 0 }) // prettier-ignore

interface Plan {
  /** First pass that draws, and the last (default: every pass from `first` on). */
  first: number
  lastDrawn?: number
  /** Pass number -> the writes made on that pass; the model reports them cumulatively. */
  writes: Record<number, ReturnType<typeof rung>>
  passes?: number
  /** The pass the picture is drawn from when it is not the first drawn one (a frame of the sprite's animation). */
  chosen?: number
  /** Passes [from, to) in which the sprite is not drawn although it draws before and after (it left and came back). */
  gap?: [number, number]
  /** More departures: each [from, to) range is also undrawn. */
  gaps?: [number, number][]
}
const run = (id: number, plan: Plan): SpriteModel => {
  const n = plan.passes ?? PASSES
  const acc: PassResult['palette'] = []
  const passes: PassResult[] = Array.from({ length: n }, (_, p) => {
    acc.push(...(plan.writes[p] ?? []))
    const drawn = p >= plan.first && p <= (plan.lastDrawn ?? n - 1) && ![...(plan.gap ? [plan.gap] : []), ...(plan.gaps ?? [])].some(([a, b]) => p >= a && p < b) // prettier-ignore
    return { pass: p, pos: { x: 0, y: 0 }, origin: { x: 0, y: 0 }, parts: drawn ? [part()] : [], uploads: [], palette: [...acc] } // prettier-ignore
  })
  return {
    id,
    anchor: { x: 0, y: 0, rawX: 0, rawY: 0 },
    chosen: plan.chosen ?? plan.first,
    dependsOn: [],
    steps: [],
    passes,
  }
}

const s = { index: 0, x: 0, y: 0, spriteId: 0x1f, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as LevelSprite // prettier-ignore
/** Char 0: pixel i holds color i for i = 1..15, so a sample per CGRAM column is one pixel. */
const chars = {
  sp1: [Uint8Array.from([...Array.from({ length: 16 }, (_, i) => i), ...new Array(48).fill(0)])],
}
const draw = (m: SpriteModel) => {
  const drawer: SpriteDrawer = () => modelResult(m as never)
  const [d] = drawSprites([s], { vram: chars, colors: COLORS }, drawer)
  const b = Buffer.from(d!.rgba, 'base64')
  return { col: (c: number) => Array.from(b.subarray(c * 4, c * 4 + 4)), unverified: d!.unverified }
}
const rgba = (w: number) => bgr555ToRgba(w)
/** The fade as a vanilla-shaped run: casting pose from pass 1, a rung every 4 passes, settled well before the end. */
const fade = (id = 0x1f): Plan & { id: number } => ({ id, first: 1, writes: { 2: rung(0), 6: rung(1), 10: rung(2), 14: rung(3) } }) // prettier-ignore

describe('runtime palette on the map (#1097)', () => {
  it('draws the colors CGRAM holds at the end of the run, in every column the upload writes', () => {
    const d = draw(run(0x1f, fade()))
    for (let c = 1; c < 8; c++) expect(d.col(c), `column ${c}`).toEqual(rgba(rung(3)[c]!.bgr555))
    expect(d.unverified).toBeUndefined()
  })

  it('composites: every column the upload does not write keeps the level row', () => {
    const d = draw(run(0x1f, fade()))
    for (let c = 8; c < 16; c++) expect(d.col(c), `column ${c}`).toEqual(COLORS[ROW + c])
  })

  it('does not depend on the sprite id', () => {
    const [a, b] = [draw(run(0x1f, fade())), draw(run(0xc5, fade()))]
    for (let c = 1; c < 16; c++) expect(b.col(c), `column ${c}`).toEqual(a.col(c))
  })

  it('takes a write made after the last drawn pass: CGRAM keeps it', () => {
    const p = { ...fade(), lastDrawn: 20, writes: { ...fade().writes, 40: rung(5) } }
    expect(draw(run(0x1f, p)).col(3)).toEqual(rgba(rung(5)[3]!.bgr555))
  })

  it('takes the end colors when the first drawn pass already held writes', () => {
    const p: Plan = { first: 3, writes: { 2: rung(0), 6: rung(1) } }
    expect(draw(run(0x1f, p)).col(3)).toEqual(rgba(rung(1)[3]!.bgr555))
  })

  it('a sprite that never writes CGRAM keeps the level row and is not marked', () => {
    const d = draw(run(0x33, { first: 0, writes: {} }))
    expect(d.col(3)).toEqual(COLORS[ROW + 3])
    expect(d.unverified).toBeUndefined()
  })

  it('marks the picture when the colors were still changing at the end of the run, and draws the end colors', () => {
    const d = draw(run(0x1f, { ...fade(), writes: { ...fade().writes, 55: rung(4) } }))
    expect(d.unverified).toMatch(/still changing/)
    expect(d.col(3)).toEqual(rgba(rung(4)[3]!.bgr555))
  })

  it('marks a slow fade whose rungs land 16 passes apart', () => {
    const w = { 2: rung(0), 18: rung(1), 34: rung(2), 50: rung(3) }
    expect(draw(run(0x1f, { first: 1, writes: w })).unverified).toMatch(/still changing/)
  })

  it('marks a sprite that only starts drawing at the very end, though its tail has no writes', () => {
    const d = draw(run(0x1f, { first: 60, writes: {} }))
    expect(d.unverified).toMatch(/only appeared/)
  })

  it('does not mark a short run: the tail test needs a run longer than its window', () => {
    expect(
      draw(run(0x1f, { first: 1, passes: 8, writes: { 2: rung(0) } })).unverified,
    ).toBeUndefined()
  })

  it.each([2, 4, 6, 8, 16])(
    'marks one color flipping every %i passes to the end of the run',
    period => {
      const writes: Plan['writes'] = { 2: rung(0) }
      for (let p = 4, k = 1; p < PASSES; p += period, k++) writes[p] = [{ index: ROW + 3, bgr555: 0x1111 * (k % 2 ? 1 : 2) }] // prettier-ignore
      expect(draw(run(0x1f, { first: 1, writes })).unverified, `period ${period}`).toMatch(
        /still changing/,
      )
    },
  )

  it('does not mark colors that settled at pass 30, well before the last 16 passes', () => {
    expect(
      draw(run(0x1f, { first: 1, writes: { ...fade().writes, 30: rung(4) } })).unverified,
    ).toBeUndefined()
  })

  it('a first draw at exactly the start of the tail is late; one pass before is not', () => {
    expect(draw(run(0x1f, { first: PASSES - 17, writes: {} })).unverified).toMatch(/only appeared/)
    expect(draw(run(0x1f, { first: PASSES - 18, writes: {} })).unverified).toBeUndefined()
  })

  it('judges a late start by the first drawn pass, not by the frame drawn (an animation frame at pass 50)', () => {
    expect(draw(run(0x1f, { ...fade(), chosen: 50 })).unverified).toBeUndefined()
  })

  it('marks a sprite that stopped being drawn after its colors changed since the picture', () => {
    const p = { ...fade(), lastDrawn: 20, writes: { ...fade().writes, 28: rung(5) } }
    expect(draw(run(0x1f, p)).unverified).toMatch(/disappeared partway/)
  })

  it('does not mark a sprite that stopped being drawn when its colors did not change since the picture', () => {
    expect(
      draw(run(0x1f, { first: 1, lastDrawn: 30, writes: { 0: rung(0) } })).unverified,
    ).toBeUndefined()
  })

  it('marks a sprite that left and came back (a fade-out and a new cycle) when its colors changed since the picture', () => {
    const p: Plan = {
      ...fade(),
      gap: [30, 59],
      writes: { ...fade().writes, 24: rung(7), 40: rung(0) },
    }
    expect(draw(run(0x1f, p)).unverified).toMatch(/disappeared partway/)
  })

  it('keeps the fade-out mark on a later frame: the colors are compared with the first drawn pass, not the frame', () => {
    const p: Plan = { ...fade(), gap: [30, 59], chosen: 60 }
    expect(draw(run(0x1f, p)).unverified).toMatch(/disappeared partway/)
  })

  it('marks an update every 22 passes: a quiet tail of 19 is shorter than the 22 between updates', () => {
    const w = { 2: rung(0), 24: rung(1), 46: rung(2) }
    expect(draw(run(0x1f, { first: 1, writes: w })).unverified).toMatch(/still changing/)
  })

  it('does not mark a long fade that finished with a quiet tail longer than its longest gap', () => {
    const w = { 2: rung(0), 14: rung(1), 26: rung(2), 38: rung(3) }
    expect(draw(run(0x1f, { first: 1, writes: w })).unverified).toBeUndefined()
  })

  it.each(Array.from({ length: 39 }, (_, i) => i + 2))(
    'an 8-rung fade, one rung every %i passes, is never unmarked and wrong',
    period => {
      const writes: Plan['writes'] = {}
      for (let k = 0; k < 8; k++) if (2 + k * period < PASSES) writes[2 + k * period] = rung(k)
      const reached = Math.min(7, Math.floor((PASSES - 3) / period))
      const d = draw(run(0x1f, { first: 1, writes }))
      if (d.unverified === undefined)
        expect(reached, 'unmarked, so the fade must have finished').toBe(7)
    },
  )

  it('marks a sprite that drew A, then B, left, and came back on A: a change while away', () => {
    const p: Plan = { first: 1, gap: [20, 40], writes: { 0: rung(0), 10: rung(1), 25: rung(0) } }
    expect(draw(run(0x1f, p)).unverified).toMatch(/disappeared partway/)
  })

  it('marks colors that changed and changed back while the sprite was away', () => {
    const p: Plan = { first: 1, gap: [20, 40], writes: { 0: rung(0), 25: rung(1), 30: rung(0) } }
    expect(draw(run(0x1f, p)).unverified).toMatch(/disappeared partway/)
  })

  it('marks end colors that differ from the last picture before it left', () => {
    const p: Plan = { first: 1, gap: [20, 25], writes: { 0: rung(0), 10: rung(1), 45: rung(2) } }
    expect(draw(run(0x1f, p)).unverified).toMatch(/disappeared partway|still changing/)
    const q: Plan = { first: 1, gap: [20, 25], writes: { 0: rung(0), 30: rung(2), 38: rung(3) } }
    expect(draw(run(0x1f, q)).unverified).toMatch(/disappeared partway/)
  })

  it('marks a single update: with no earlier gap to compare it cannot be shown finished', () => {
    expect(draw(run(0x1f, { first: 1, writes: { 2: rung(0) } })).unverified).toMatch(/only once/)
  })

  it('marks a quiet tail exactly as long as the longest gap between changes', () => {
    expect(draw(run(0x1f, { first: 1, writes: { 3: rung(0), 33: rung(1) } })).unverified).toMatch(
      /still changing/,
    )
  })

  it('marks colors restored after it came back: B was on screen when it left, A is there now', () => {
    const p: Plan = { first: 1, gap: [20, 25], writes: { 0: rung(0), 10: rung(1), 30: rung(0) } }
    expect(draw(run(0x1f, p)).unverified).toMatch(/disappeared partway/)
  })

  it('checks the colors before every departure, not only the first: A, left, B, left again, A restored', () => {
    const p: Plan = {
      first: 1,
      gaps: [
        [10, 13],
        [24, 28],
      ],
      writes: { 0: rung(0), 20: rung(1), 30: rung(0) },
    }
    expect(draw(run(0x1f, p)).unverified).toMatch(/disappeared partway/)
  })

  it('marks a lone update that came before the first draw', () => {
    expect(draw(run(0x1f, { first: 30, writes: { 10: rung(0) } })).unverified).toMatch(/only once/)
  })

  it('marks changes that are short of the 16-pass tail though each gap is shorter than the quiet span', () => {
    const w = { 40: rung(0), 44: rung(1), 48: rung(2), 52: rung(3) }
    expect(draw(run(0x1f, { first: 1, writes: w })).unverified).toMatch(/still changing/)
  })

  it('compares the quiet span with the longest earlier gap, not the first', () => {
    const w = { 2: rung(0), 5: rung(1), 35: rung(2), 38: rung(3) }
    expect(draw(run(0x1f, { first: 1, writes: w })).unverified).toMatch(/still changing/)
  })
})
