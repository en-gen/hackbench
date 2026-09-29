/**
 * WorkingRom's incremental path against a full replay (#405). Random appends,
 * undos, redos and reopens over a synthetic ROM, headered and bare; after
 * every step the cached bytes must equal replaying the whole stack from the
 * base. Seeded, so a failure names a reproducible seed and step.
 */
import { describe, it, expect } from 'vitest'
import { encode } from '../../../src/rom/LcLz2'
import { GFX_FILE_COUNT } from '../../../src/rom/GfxArena'
import { GfxCharEdit, foldGfxRun, readGfxBase } from '../../../src/rom/GfxLayer'
import { applyOp, readBgr555Word } from '../../../src/rom/PaletteOp'
import { COPIER_HEADER_SIZE } from '../../../src/rom/addressing'
import { Layer, WorkingRom } from '../../../src/project/WorkingRom'
import { buildCart } from '../support/syntheticGfxCart'

const BYTES = 11 * 24
const FILES = [0, 1, 2, 3, 7, 20, 49]

function romBytes(headered: boolean, filler: number): Uint8Array {
  const streams = Array.from({ length: GFX_FILE_COUNT }, (_, i) =>
    encode(
      FILES.slice(0, 4).includes(i)
        ? new Uint8Array(BYTES)
        : Uint8Array.from({ length: BYTES }, (_, k) => (i * 13 + k * 5) & 0xff),
    ),
  )
  return new Uint8Array(buildCart({ streams, filler, headered }).rom.buffer)
}

function rng(seed: number): () => number {
  let s = seed >>> 0
  return () => (s = (s * 1664525 + 1013904223) >>> 0) / 2 ** 32
}

/** The whole stack replayed from the base, every run folded in one pass. */
function replay(base: Uint8Array, header: boolean, layers: readonly Layer[]): Uint8Array {
  const romSize = base.length - (header ? COPIER_HEADER_SIZE : 0)
  const out = new Uint8Array(base)
  const gfxBase = readGfxBase(base)
  let run: GfxCharEdit[] = []
  const flush = (): void => {
    if (run.length > 0) foldGfxRun(out, header, gfxBase, run)
    run = []
  }
  for (const l of layers) {
    if (l.kind === 'gfx') run.push(l)
    else if (l.kind === undefined) {
      flush()
      for (const op of l.ops) applyOp(out, op, romSize, header)
    }
  }
  flush()
  return out
}

function walk(seed: number, headered: boolean, steps: number): string[] {
  const r = rng(seed)
  const pick = (n: number): number => Math.floor(r() * n)
  const base = romBytes(headered, [0, 8, 40, 300][pick(4)]!)
  const hdr = headered ? COPIER_HEADER_SIZE : 0
  let w = new WorkingRom(base, headered)
  const problems: string[] = []
  for (let s = 0; s < steps && problems.length === 0; s++) {
    const x = r()
    const at = `seed ${seed} step ${s}`
    try {
      if (x < 0.45) {
        const pixels = Array.from({ length: 1 + pick(6) }, () => ({
          x: pick(8),
          y: pick(8),
          value: pick(8),
        }))
        w.append({
          id: `g${s}`,
          label: 'g',
          kind: 'gfx',
          file: FILES[pick(7)]!,
          tile: pick(11),
          pixels,
        })
      } else if (x < 0.65) {
        const offset = 0x7000 + 2 * pick(8)
        const old = `$${readBgr555Word(w.bytes(), offset + hdr).toString(16)}`
        const address = `$00${(0x8000 + offset).toString(16)}`
        const ops = [{ address, old, new: `$${pick(0x7fff).toString(16)}` }]
        // Two writes to one address: undo must restore them last-first.
        if (r() < 0.3) ops.push({ address, old, new: `$${pick(0x7fff).toString(16)}` })
        w.append({ id: `w${s}`, label: 'w', ops })
      } else if (x < 0.82) w.undo()
      else if (x < 0.94) w.redo()
      else {
        const [stack, redo] = [[...w.stack], [...w.redoStack]]
        w = new WorkingRom(base, headered)
        w.restore(stack)
        w.restoreRedo(redo)
      }
    } catch {
      // A refused edit is fine; the stack it left is still checked below.
    }
    const want = replay(base, headered, w.stack)
    if (Buffer.compare(Buffer.from(w.bytes()), Buffer.from(want)) !== 0) {
      problems.push(`${at}: the working copy differs from a full replay`)
    }
    const k = w.stack.length - 1
    if (k >= 0 && r() < 0.15) {
      const below = replay(base, headered, w.stack.slice(0, k))
      const n = want.reduce((c, v, i) => c + (v === below[i] ? 0 : 1), 0)
      if (w.bytesChangedBy(k) !== n) problems.push(`${at}: bytesChangedBy is not ${n}`)
    }
  }
  return problems
}

describe('the incremental working copy equals a full replay', () => {
  it.each([false, true])(
    'headered %s, three seeds',
    headered => {
      const problems = [11, 23, 37].flatMap(seed => walk(seed + (headered ? 1 : 0), headered, 40))
      expect(problems).toEqual([])
      // A crash guard, not a budget: about 1.5 s locally, 5.4 s on a CI runner.
    },
    60_000,
  )
})
