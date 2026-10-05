/**
 * Grades a sprite model against one Mesen-recorded sprite (a `layers_v5`
 * `sprite_spawns.json` record or a spawn-mode fixture frame). Oracle only:
 * nothing here feeds the runner.
 *
 * Verdicts, best pass wins (the recorded frame is not known, so any of the
 * runner's passes may be the one Mesen drew):
 *   exact    same tiles, sizes, palette/flip bits and offsets from the sprite
 *   shape    same tiles and sizes, same arrangement among themselves, but not at
 *            the same offsets from the sprite (it moved, or the anchor differs)
 *   close    same tile multiset (tile byte, size, palette row), offsets or
 *            flips differ
 *   wrong    a pass drew, nothing matches
 *   refused  the runner refused
 *   empty    the runner drew nothing in any pass
 * Priority bits are not compared (same as capture_decode.sameShape).
 */
import type { SpriteModel } from '../../../src/rom/sprites/interp/SpriteRunner'

export interface RecordedPiece {
  dx: number
  dy: number
  tile: number
  attr: number
  large: boolean
}

export type Verdict = 'exact' | 'shape' | 'close' | 'wrong' | 'refused' | 'empty'

export interface Grade {
  verdict: Verdict
  /** Pass that matched best, for exact/close. */
  pass?: number
  /** Why it is not exact, for wrong/close. */
  detail?: string
}

const exactKey = (p: RecordedPiece): string =>
  [p.dx, p.dy, p.tile, p.attr & 0xcf, +p.large].join(',')
/** Arrangement only: offsets taken from the top-left of the pieces. */
const shapeKeys = (ps: RecordedPiece[]): string => {
  const x0 = Math.min(...ps.map(p => p.dx))
  const y0 = Math.min(...ps.map(p => p.dy))
  return keys(
    ps.map(p => ({ ...p, dx: p.dx - x0, dy: p.dy - y0 })),
    exactKey,
  )
}
const closeKey = (p: RecordedPiece): string => [p.tile, p.attr & 0x0f, +p.large].join(',')
const keys = (ps: RecordedPiece[], f: (p: RecordedPiece) => string): string =>
  ps.map(f).sort().join(';')

/** The model's parts for one pass, as the recorded shape, offsets from the pass's own position. */
export function passPieces(m: SpriteModel, pass: number): RecordedPiece[] {
  const a = m.anchor!
  const p = m.passes[pass]
  return p.parts
    .filter(q => !(q.oy >= 224 && q.oy + q.size <= 256)) // parked below the screen, as the capture drops them
    .map(q => ({
      dx: q.dx + (a.x - p.pos.x),
      dy: q.dy + (a.y - p.pos.y),
      tile: q.char & 0xff,
      attr: q.attr,
      large: q.size === 16,
    }))
}

export function grade(m: SpriteModel, recorded: RecordedPiece[]): Grade {
  if (m.refusal) return { verdict: 'refused', detail: m.refusal }
  if (m.emptyReason) return { verdict: 'empty', detail: m.emptyReason }
  const want = keys(recorded, exactKey)
  const wantClose = keys(recorded, closeKey)
  const wantShape = recorded.length ? shapeKeys(recorded) : ''
  let shape: Grade | null = null
  let close: Grade | null = null
  for (let i = 0; i < m.passes.length; i++) {
    const got = passPieces(m, i)
    if (keys(got, exactKey) === want) return { verdict: 'exact', pass: i }
    if (!shape && got.length && shapeKeys(got) === wantShape)
      shape = {
        verdict: 'shape',
        pass: i,
        detail: 'same arrangement, offset from the sprite differs',
      }
    if (!close && keys(got, closeKey) === wantClose)
      close = { verdict: 'close', pass: i, detail: 'same tiles, offsets or flips differ' }
  }
  if (shape) return shape
  if (close) return close
  const n = m.passes.map(p => p.parts.length)
  return {
    verdict: 'wrong',
    detail: `recorded ${recorded.length} pieces; model drew ${[...new Set(n)].join('/')} per pass`,
  }
}
