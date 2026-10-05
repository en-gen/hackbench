/**
 * Grades a sprite model against one Mesen-recorded sprite (a `layers_v5`
 * `sprite_spawns.json` record or a spawn-mode fixture frame). Oracle only:
 * nothing here feeds the runner.
 *
 * Verdicts, best recorded frame wins (the frame Mesen drew is not known):
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
import type { LevelState } from '../../../src/rom/sprites/interp/SpriteSeed'

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
  /** The pass graded (the model's chosen one). */
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

const RANK: Verdict[] = ['exact', 'shape', 'close', 'wrong']

/** One pass against one recorded frame. */
function gradePass(got: RecordedPiece[], recorded: RecordedPiece[], pass: number): Grade {
  if (keys(got, exactKey) === keys(recorded, exactKey)) return { verdict: 'exact', pass }
  if (got.length && recorded.length && shapeKeys(got) === shapeKeys(recorded))
    return { verdict: 'shape', pass, detail: 'same arrangement, offset from the sprite differs' }
  if (keys(got, closeKey) === keys(recorded, closeKey))
    return { verdict: 'close', pass, detail: 'same tiles, offsets or flips differ' }
  return { verdict: 'wrong', pass }
}

/**
 * Grades only the pass the model's frame policy picked (`m.chosen`) against
 * EVERY frame Mesen recorded for the sprite (set membership: it must equal
 * some recorded frame).
 */
export function grade(m: SpriteModel, recorded: RecordedPiece[][]): Grade {
  if (m.refusal) return { verdict: 'refused', detail: m.refusal }
  if (m.emptyReason || m.chosen === undefined) return { verdict: 'empty', detail: m.emptyReason }
  const got = passPieces(m, m.chosen)
  let best: Grade = { verdict: 'wrong' }
  for (const rec of recorded) {
    const g = gradePass(got, rec, m.chosen)
    if (RANK.indexOf(g.verdict) < RANK.indexOf(best.verdict)) best = g
    if (best.verdict === 'exact') return best
  }
  if (best.verdict === 'wrong')
    best.detail = `recorded ${recorded.map(r => r.length).join('/')} pieces; model drew ${m.passes[m.chosen].parts.length}`
  return best
}

/** The LevelState cells out of a level-load WRAM image (oracle seed, never a runtime input). */
export function levelOf(w: Uint8Array): Partial<LevelState> {
  return {
    screenMode: w[0x5b], screens: w[0x5d], spriteProps: w[0x64], water: w[0x85], slippery: w[0x86],
    buoyancy: w[0x190e], spriteMemory: w[0x1692], slopes: w[0x82] | (w[0x83] << 8), rng: [w[0x148b], w[0x148c]],
  } // prettier-ignore
}
