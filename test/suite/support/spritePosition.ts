/**
 * Tier 2 of the sprite grader: WHERE the pieces sit on the map, against a Mesen
 * capture. Tier 1 (spriteGrade.ts) compares shape relative to the sprite and
 * ignores position. Oracle only: nothing here feeds the runner. Pure, no fs.
 *
 * Both sides are placed with the capture camera, which the model is seeded
 * with, so the camera cancels; position is compared in map coordinates as a
 * multiset of (mapX, mapY, large). Tiles are tier 1's.
 *
 * Pairing: the capture's `entries[]` are the drawing at `drawnFrame`, the first
 * frame with every tile complete on screen (headless_capture.lua:1372,1401),
 * not the first OAM write. `firstRealFrame` is the first MAIN after INIT
 * (headless_capture.lua:1305-1311), which is the model's pass 0
 * (SpriteRunner.ts:509-524), so the target is pass `drawnFrame - firstRealFrame`
 * itself; `chosen` (the first drawing pass) is not added. Measured lag over the
 * 1957 graded records: 1 to 116 frames. All 80 `lagged` records are
 * captures whose first draw came 31 to 89 frames after the first MAIN (likely
 * the level fade-in; not traced). Not re-aligned to the first draw.
 *   exact    every piece position matches
 *   off      both sides drew, positions differ; `delta` is the anchor (min x/y) gap
 *   missing  one side drew nothing once parked pieces are dropped, the other drew
 *            on screen; or the record has no drawnFrame or firstRealFrame
 *   parked   both sides drew only parked pieces, at matching positions (agreement)
 *   late     the model had not drawn yet at the target pass, the capture had
 *   lagged   the target pass is past the model's pass count, drew or not (not graded)
 *   refused  the model run was refused
 */
import type { SpriteModel } from '../../../src/rom/sprites/interp/SpriteRunner'

/** A raw OAM piece: x is the 9-bit screen X, y the 8-bit line. */
export interface ScreenPiece {
  x: number
  y: number
  large: boolean
}

export type PositionVerdict = 'exact' | 'off' | 'missing'
export type RecordVerdict = PositionVerdict | 'parked' | 'late' | 'lagged' | 'refused'

export interface PositionGrade {
  verdict: PositionVerdict
  /** Gap between the two sides' top-left-most pieces (got minus want), for `off`. */
  delta?: { x: number; y: number }
}

/** A capture entry as recorded: 8-bit x, sizeXHigh bit 0 = X bit 8, bit 1 = large. */
export interface CaptureEntry {
  x: number
  y: number
  sizeXHigh: number
}

/** Pieces parked below the screen are dropped on both sides, as tier 1 does. */
const parked = (p: ScreenPiece): boolean => p.y >= 224 && p.y + (p.large ? 16 : 8) <= 256

/**
 * Screen to map: the camera plus the screen position, X as the full 9 bits
 * (the runner's readParts takes it the same way) and Y as the 8-bit line. Both
 * sides use this one transform and one camera, so any wrap cancels.
 */
export function toMap(
  pieces: ScreenPiece[],
  cam: { x: number; y: number },
  keepParked = false,
): ScreenPiece[] {
  return pieces
    .filter(p => keepParked || !parked(p))
    .map(p => ({ x: cam.x + p.x, y: cam.y + p.y, large: p.large }))
}

/**
 * The capture's pieces at its drawn frame. Graded captures never set X bit 8,
 * so the 9-bit path is covered by synthetic tests only.
 */
export function capturePieces(entries: CaptureEntry[]): ScreenPiece[] {
  return entries.map(e => ({
    x: (e.x & 0xff) | ((e.sizeXHigh & 1) << 8),
    y: e.y,
    large: !!(e.sizeXHigh & 2),
  }))
}

/**
 * The model's pieces at pass `lag`, counted from pass 0 = the first MAIN (raw
 * OAM position, `ox` the 9-bit X). [] when no pass drew or the pass drew
 * nothing; undefined when the target pass is past the pass count.
 */
export function modelPieces(m: SpriteModel, lag = 0): ScreenPiece[] | undefined {
  if (m.chosen === undefined) return []
  const pass = m.passes[lag]
  return pass && pass.parts.map(q => ({ x: q.ox, y: q.oy, large: q.size === 16 }))
}

const key = (p: ScreenPiece): string => `${p.x},${p.y},${+p.large}`
const sorted = (ps: ScreenPiece[]): string => ps.map(key).sort().join(';')

export function gradePosition(got: ScreenPiece[], want: ScreenPiece[]): PositionGrade {
  if (!got.length || !want.length) return { verdict: 'missing' }
  if (sorted(got) === sorted(want)) return { verdict: 'exact' }
  const lo = (ps: ScreenPiece[], f: (p: ScreenPiece) => number): number => Math.min(...ps.map(f))
  return {
    verdict: 'off',
    delta: {
      x: lo(got, p => p.x) - lo(want, p => p.x),
      y: lo(got, p => p.y) - lo(want, p => p.y),
    },
  }
}

/** One corpus record: refused, lagged, late and parked are told apart from missing. */
export function gradeRecord(
  m: SpriteModel,
  lag: number | undefined,
  entries: CaptureEntry[],
  cam: { x: number; y: number },
): { verdict: RecordVerdict; delta?: { x: number; y: number }; detail?: string } {
  if (m.refusal !== undefined) return { verdict: 'refused' }
  if (lag === undefined)
    return { verdict: 'missing', detail: 'record lacks drawnFrame or firstRealFrame' }
  // A lag past the pass count is lagged even for a model that never drew.
  if (m.chosen === undefined && lag > m.passes.length) return { verdict: 'lagged' }
  const got = modelPieces(m, lag)
  if (got === undefined) return { verdict: 'lagged' }
  const cap = capturePieces(entries)
  const want = toMap(cap, cam)
  if (m.chosen !== undefined && lag < m.chosen && want.length) return { verdict: 'late' }
  // Both sides drew, but only parked pieces: compare them unfiltered.
  if (!want.length && !toMap(got, cam).length && got.length && cap.length) {
    const g = gradePosition(toMap(got, cam, true), toMap(cap, cam, true))
    return g.verdict === 'exact' ? { verdict: 'parked' } : g
  }
  return gradePosition(toMap(got, cam), want)
}
