/**
 * Tier 2 of the sprite grader: WHERE the pieces sit on the map, against a Mesen
 * capture. Tier 1 (spriteGrade.ts) compares shape relative to the sprite and
 * ignores position. Oracle only: nothing here feeds the runner. Pure, no fs.
 *
 * Both sides are put in map coordinates (screen x/y plus that side's own
 * camera) and compared as a multiset of (mapX, mapY, large). Tiles are tier 1's.
 *   exact    every piece position matches
 *   off      both sides drew, positions differ; `delta` is the anchor (min x/y) gap
 *   missing  one side drew nothing
 */
import type { SpriteModel } from '../../../src/rom/sprites/interp/SpriteRunner'

/** A raw OAM piece: x is the 9-bit screen X, y the 8-bit line. */
export interface ScreenPiece {
  x: number
  y: number
  large: boolean
}

export type Placed = ScreenPiece

export type PositionVerdict = 'exact' | 'off' | 'missing'

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
 * sides use this one transform, so any wrap cancels.
 */
export function toMap(pieces: ScreenPiece[], cam: { x: number; y: number }): Placed[] {
  return pieces
    .filter(p => !parked(p))
    .map(p => ({
      x: cam.x + p.x,
      y: cam.y + p.y,
      large: p.large,
    }))
}

/** The capture's pieces at its first OAM write. */
export function capturePieces(entries: CaptureEntry[]): ScreenPiece[] {
  return entries.map(e => ({
    x: (e.x & 0xff) | ((e.sizeXHigh & 1) << 8),
    y: e.y,
    large: !!(e.sizeXHigh & 2),
  }))
}

/** The model's pieces at its first drawn pass (`chosen`), raw OAM position. */
export function modelPieces(m: SpriteModel): ScreenPiece[] {
  if (m.chosen === undefined) return []
  return m.passes[m.chosen].parts.map(q => ({ x: q.ox, y: q.oy, large: q.size === 16 }))
}

const key = (p: Placed): string => `${p.x},${p.y},${+p.large}`
const sorted = (ps: Placed[]): string => ps.map(key).sort().join(';')

export function gradePosition(got: Placed[], want: Placed[]): PositionGrade {
  if (!got.length || !want.length) return { verdict: 'missing' }
  if (sorted(got) === sorted(want)) return { verdict: 'exact' }
  const lo = (ps: Placed[], f: (p: Placed) => number): number => Math.min(...ps.map(f))
  return {
    verdict: 'off',
    delta: {
      x: lo(got, p => p.x) - lo(want, p => p.x),
      y: lo(got, p => p.y) - lo(want, p => p.y),
    },
  }
}
