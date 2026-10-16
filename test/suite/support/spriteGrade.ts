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
import type { RomFile } from '../../../src/rom/RomFile'
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

/** An X offset folded into 9-bit signed OAM range (-256..255), as the hardware's X wraps. */
export const wrap9 = (v: number): number => {
  const r = ((v % 512) + 512) % 512
  return r > 255 ? r - 512 : r
}

/** A Y offset folded into 8-bit signed range (-128..127), as the capture records it. */
export const wrap8 = (v: number): number => {
  const r = ((v % 256) + 256) % 256
  return r > 127 ? r - 256 : r
}

/** The model's parts for one pass, as the recorded shape, offsets from the pass's own position. */
export function passPieces(m: SpriteModel, pass: number): RecordedPiece[] {
  const p = m.passes[pass]
  // The capture measures from the sprite at its first OAM write (headless_capture.lua:1285, note at 1455).
  const at = p.drawPos ?? p.pos
  // Only Y $F0 (parked) is absent from a recorded frame: the capture keeps a frame only when no
  // written entry has it (hackbench-validation headless_capture.lua:1352, gate at 1371-1372).
  // readParts already skips $F0 (SpriteRunner.ts:404), so this is a guard that should not fire.
  return p.parts
    .filter(q => q.oy !== 0xf0)
    .map(q => ({
      // q.dx is wrapped against the draw origin; moving it to the pass position can leave -256..255, and
      // the capture's offset is the 9-bit one from the sprite (#869: 160 + 112 is 272 here, -240 recorded).
      // OAM X is 9 bits: SMWDisX bank_01.asm:7634-7642 (high X bit set), compare in CODE_01B844 7668-7675.
      // Y is 8 bits, folded into -128..127 by the capture (headless_capture.lua:1389).
      dx: wrap9(q.dx + (p.origin.x - at.x)),
      dy: wrap8(q.dy + (p.origin.y - at.y)),
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
  // Count the list the panel draws (got), not the raw parts: parked tiles are dropped there (#864).
  if (best.verdict === 'wrong')
    best.detail = `recorded ${recorded.map(r => r.length).join('/')} pieces; model drew ${got.length}`
  return best
}

/**
 * A planted defect that KEEPS the dispatch shape, so the runner still runs
 * INIT and MAIN and only the graded output can notice: every `STA $0302,Y`
 * (the OAM tile store, `99 02 03`) in banks $01-$03, where the sprite code
 * lives, becomes `STA $0303,Y` (the attribute byte). Returns the count patched
 * so a caller can prove it planted something. Test helper, not a ROM trace.
 */
export function plantTileStoreDefect(rom: RomFile): number {
  const buf = rom.buffer
  const base = rom.hasHeader ? 0x200 : 0
  let n = 0
  for (let i = base + 0x8000; i + 2 < base + 0x20000; i++)
    if (buf[i] === 0x99 && buf[i + 1] === 0x02 && buf[i + 2] === 0x03) {
      buf[i + 1] = 0x03
      n++
    }
  return n
}
