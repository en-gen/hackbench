/**
 * Differential: the L1 handler interpreter against the hand ports, on vanilla
 * (en-gen/hackbench#664). Every standard object x size x tileset dispatcher,
 * and every extended object, placed at screen 1, row 2, column 3.
 *
 * Any disagreement not on KNOWN_DISAGREEMENTS fails, and so does any refusal
 * not on KNOWN_REFUSALS. Entries are keyed by the routine the interpreter
 * dispatched to last (its leaf), and each says why it is allowed.
 */
import { describe, it, expect, beforeAll } from 'vitest'
import type { RomFile } from '../../../src/rom/RomFile'
import { fingerprint } from '../../../src/rom/Fingerprint'
import { createGrid, expandObject, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import type { LevelObject } from '../../../src/rom/LevelParser'
import type { TileGrid } from '../../../src/rom/objectHandlers/cursor'
import { readLongPointer } from '../../../src/rom/objectHandlers/romData'
import {
  interpret,
  horizontalPlacement,
  applyWrites,
  ENTRY_STANDARD,
  ENTRY_EXTENDED,
  EXECUTE_PTR_LONG_SHA256,
} from '../../../src/rom/objectHandlers/interpret'
import { hasRom, freshRom, VANILLA } from '../support/corpus'

const X = 19
const Y = 2
const hi = (s: number) => s >> 4
const lo = (s: number) => s & 0x0f
const all = () => true

type Why =
  | { issue: number } // an in-range port bug, confirmed against the ASM
  | { zeroNibble: string } // the game's 8-bit counter wraps to 256; the port does not
  | { outOfRange: string } // the size indexes past the routine's data table
  | { quirk: string } // the game draws it this way; the port draws the intent

interface Known {
  routine: number
  sizes: (size: number) => boolean
  why: Why
}

const WRAP_HI = { zeroNibble: 'high nibble 0 wraps the row counter (DEC/BNE)' }
const WRAP_LO = { zeroNibble: 'low nibble 0 wraps the column counter (DEC/BNE)' }
const FLOOR = {
  quirk: 'from row 2 the object runs past row 26 into the next screen; the port clips',
}

// prettier-ignore
const KNOWN_DISAGREEMENTS: Known[] = [
  { routine: 0x0dadeb, sizes: all, why: { issue: 652 } },
  { routine: 0x0dba0a, sizes: all, why: { issue: 668 } },
  { routine: 0x0dba4c, sizes: all, why: { issue: 669 } },
  { routine: 0x0dee17, sizes: all, why: { issue: 670 } },
  { routine: 0x0def67, sizes: all, why: { issue: 671 } },
  { routine: 0x0df066, sizes: all, why: { issue: 672 } },
  { routine: 0x0db571, sizes: all, why: { issue: 673 } },
  { routine: 0x0dc3d8, sizes: all, why: { issue: 674 } },
  { routine: 0x0de971, sizes: all, why: { issue: 675 } },
  ...[0x0daa26, 0x0db224, 0x0db51f, 0x0dc5d8, 0x0dd1a5, 0x0deec0].map(routine => ({ routine, sizes: (s: number) => hi(s) === 0, why: WRAP_HI })),
  ...[0x0db547, 0x0db5b7, 0x0dc478, 0x0dd103, 0x0dd145, 0x0dd182, 0x0de135, 0x0ded12, 0x0ded43, 0x0dedb9, 0x0def45].map(routine => ({ routine, sizes: (s: number) => lo(s) === 0, why: WRAP_LO })),
  { routine: 0x0defa8, sizes: s => hi(s) === 0 || lo(s) === 0, why: { zeroNibble: 'either nibble 0 wraps its DEC/BNE counter' } },
  { routine: 0x0daab4, sizes: s => lo(s) === 0, why: WRAP_LO },
  { routine: 0x0daab4, sizes: s => hi(s) >= 4, why: { outOfRange: 'X = hi*2 into 8-byte DATA_0DAAA4/AC (bank_0D.asm:2195-2211)' } },
  { routine: 0x0dcef2, sizes: s => hi(s) >= 2, why: { outOfRange: 'X = hi into 2-byte DATA_0DCEF0 (bank_0D.asm:5586-5601)' } },
  { routine: 0x0dd1d9, sizes: s => lo(s) >= 4, why: { outOfRange: 'X = lo into 4-byte DATA_0DD1CB/CF (bank_0D.asm:6031-6056)' } },
  { routine: 0x0ddac8, sizes: s => lo(s) >= 2, why: { outOfRange: 'X = lo into 2-byte DATA_0DDAC4/C6 (bank_0D.asm:6444-6466)' } },
  { routine: 0x0db7aa, sizes: s => hi(s) + lo(s) >= 24, why: FLOOR },
  { routine: 0x0dc58a, sizes: s => hi(s) >= 12, why: FLOOR },
  ...[0x0dd080, 0x0dd0c3, 0x0ddd99, 0x0dde3c].map(routine => ({ routine, sizes: (s: number) => lo(s) >= 12, why: FLOOR })),
  { routine: 0x0dc4c9, sizes: s => lo(s) >= 12, why: { quirk: 'no bookmark restore on U (bank_0D.asm:5079-5091), so row 2 starts a screen right after the first crosses the edge; E1 adds it' } },
  { routine: 0x0dbadc, sizes: all, why: { quirk: 'rows wrap through LevelLoadPos, not _E, and each block steps $B0 (bank_0D.asm:4460-4470), so off column 0 and above row 10 the game drifts' } },
  { routine: 0x0dec33, sizes: all, why: { quirk: 'no bookmark restore: off column 0 each row drifts one screen right (bank_0D.asm:7857-7872)' } },
]

/** Refusals are keyed by the top-level handler, since a sub-dispatch past its
 *  table has no routine of its own. `0` is a null extended slot. */
// prettier-ignore
const KNOWN_REFUSALS: Record<string, number[]> = {
  // Extended $02-$0F are null, and CODE_0DCF53 / ADDR_0DD070 index past their inline tables.
  'is not ROM': [0, 0x0dcf53, 0x0dd070],
  // The ASM runs on into whatever follows ADDR_0DD070's table.
  'not in the allowed set': [0x0dd070],
  // Tall or wrapping sizes placed at row 2; ext $01 writes $1928, which the parser owns.
  'write outside the tile buffer': [0x0dab3e, 0x0db604, 0x0db863, 0x0dbadc, 0x0dcf53, 0x0ddaf2, 0x0ddf3a, 0x0da53d],
  'write budget': [0x0defa8], // size 0: 256 x 256 cells (bank_0D.asm:8378)
  'unknown pointer byte at $65': [0x0da512], // ext $00 screen exit reads the level stream
}

/** Visit every case once; `check` sees the port grid beside the interpreter's. */
function sweep(
  rom: RomFile,
  visit: (
    key: string,
    leaf: number,
    top: number,
    size: number,
    refusal: string | null,
    differs: boolean,
  ) => void,
): void {
  const tilesets = new Map<number, number>()
  for (let ts = 0; ts < 15; ts++) {
    const d = readLongPointer(rom, 0x0da41e + ts * 3)!
    if (!tilesets.has(d)) tilesets.set(d, ts)
  }
  const cases: ['standard' | 'extended', number, number, number][] = []
  for (const ts of tilesets.values())
    for (let o = 1; o < 64; o++) for (let s = 0; s < 256; s++) cases.push(['standard', ts, o, s])
  for (let e = 0; e < 256; e++) cases.push(['extended', 0, e, e])

  let port = createGrid(32)
  let mine = createGrid(32)
  for (const [kind, ts, o, s] of cases) {
    const r = interpret(
      rom,
      kind === 'standard' ? ENTRY_STANDARD : ENTRY_EXTENDED,
      horizontalPlacement(kind, o, s, X, Y),
      { tileset: ts },
    )
    const key = `${kind} ts${ts} $${o.toString(16)} size $${s.toString(16)}`
    const leaf = r.dispatches[r.dispatches.length - 1] ?? 0
    const top = r.dispatches[kind === 'standard' ? 1 : 0] ?? 0
    if (r.refusal) {
      visit(key, leaf, top, s, r.refusal.reason, false)
      continue
    }
    // #660: handle_0DB49E never returns at height 0. Not fixed here.
    if (kind === 'standard' && o === 0x1e && hi(s) === 0) continue
    const obj = { type: kind, objectNumber: o, settings: s, x: X, y: Y } as LevelObject
    expandObject(port, obj, rom, ts)
    applyWrites(mine, r.writes)
    const differs = !sameGrid(port, mine)
    visit(key, leaf, top, s, null, differs)
    if (differs || r.writes.length > 0) [port, mine] = [createGrid(32), createGrid(32)]
  }
}

function sameGrid(a: TileGrid, b: TileGrid): boolean {
  for (let row = 0; row < a.length; row++) {
    const n = Math.max(a[row].length, b[row].length)
    for (let c = 0; c < n; c++)
      if ((a[row][c] ?? TILE_EMPTY) !== (b[row][c] ?? TILE_EMPTY)) return false
  }
  return true
}

const hex = (a: number) => '$' + a.toString(16).toUpperCase().padStart(6, '0')

describe.skipIf(!hasRom(VANILLA))('interpret vs the ports, vanilla (#664)', () => {
  const unexpected: string[] = []
  const unexplainedRefusals: string[] = []
  const usedEntries = new Set<Known>()
  const usedRefusals = new Set<string>()
  let runs = 0
  let agreed = 0

  beforeAll(() => {
    sweep(freshRom(VANILLA), (key, leaf, top, size, refusal, differs) => {
      runs++
      if (refusal) {
        const kind = Object.keys(KNOWN_REFUSALS).find(k => refusal.includes(k))
        if (kind && KNOWN_REFUSALS[kind].includes(top)) usedRefusals.add(`${kind} ${top}`)
        else unexplainedRefusals.push(`${key} (${hex(top)}): ${refusal}`)
        return
      }
      if (!differs) return void agreed++
      const entry = KNOWN_DISAGREEMENTS.find(k => k.routine === leaf && k.sizes(size))
      if (entry) usedEntries.add(entry)
      else unexpected.push(`${key} leaf ${hex(leaf)}`)
    })
  }, 300_000)

  it('recognizes ExecutePtrLong on vanilla by its fingerprint', () => {
    expect(fingerprint(freshRom(VANILLA).readAt(0x0086fa, 36))).toBe(EXECUTE_PTR_LONG_SHA256)
  })

  it('ran every case, and most agree', () => {
    expect(runs).toBe(5 * 63 * 256 + 256 - 5 * 16)
    expect(agreed).toBeGreaterThan(75_000)
  })

  it('has no disagreement outside the allow-list', () => {
    expect(unexpected.slice(0, 20)).toEqual([])
  })

  it('has no refusal outside the allow-list', () => {
    expect(unexplainedRefusals.slice(0, 20)).toEqual([])
  })

  it('has no stale allow-list entry', () => {
    const stale = KNOWN_DISAGREEMENTS.filter(k => !usedEntries.has(k)).map(k => hex(k.routine))
    const staleRefusals = Object.entries(KNOWN_REFUSALS).flatMap(([kind, tops]) =>
      tops.filter(t => !usedRefusals.has(`${kind} ${t}`)).map(t => `${kind} ${hex(t)}`),
    )
    expect([...stale, ...staleRefusals]).toEqual([])
  })
})
