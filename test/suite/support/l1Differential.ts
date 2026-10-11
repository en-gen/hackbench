/**
 * The #351 differential: every L1 object, size and tileset dispatcher, run
 * through the interpreter and the hand ports, at three columns of screen 5.
 * Shared by the corpus test and by whoever regenerates its allow-list.
 *
 * Each case is placed on the first candidate row where it FITS: moving it one
 * row down moves every write exactly one row down on the same screen. A write
 * that runs past row 26 or above row 0 lands on another screen and breaks
 * that, so objects are compared where the level can hold them. A case that
 * fits nowhere is compared at its first candidate and marked `fits: false`.
 */
import { createHash } from 'node:crypto'
import type { RomFile } from '../../../src/rom/RomFile'
import { createGrid, expandObject, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { SCREEN_H, type LevelObject } from '../../../src/rom/LevelParser'
import type { TileGrid } from '../../../src/rom/objectHandlers/cursor'
import {
  ADDR_TILESET_DISPATCH,
  TILESET_DISPATCH_COUNT,
  STANDARD_HANDLER_COUNT,
  EXTENDED_DISPATCH_COUNT,
  readLongPointerTable,
} from '../../../src/rom/objectHandlers/romData'
import {
  VANILLA_PRIMITIVES,
  interpret,
  horizontalPlacement,
  applyWrites,
  ENTRY_STANDARD,
  ENTRY_EXTENDED,
  type BufferWrite,
  type InterpretResult,
} from '../../../src/rom/objectHandlers/interpret'

type Kind = 'standard' | 'extended'

export interface DiffRun {
  kind: Kind
  tileset: number
  obj: number
  size: number
  /** Column within screen 5, and the row the case was compared at. */
  col: number
  row: number
  fits: boolean
  /** Last ExecutePtrLong target (the leaf routine) and the top-level handler. */
  leaf: number
  top: number
  refusal: string | null
  /** Null when the port was not run (a refusal). */
  differs: boolean | null
  /** Like `differs`, but only over the object's own screen (see sameScreen). */
  ownScreenDiffers: boolean | null
  /** SHA-1 of the interpreter's writes, 12 hex digits. */
  digest: string
  /**
   * The port's written-cell map and the interpreter's differ (see
   * WrittenCells), $25 writes included. Null for a refusal. An agreeing run
   * (`differs` false) with this true means the two sides disagree only on
   * writes of the empty tile $25.
   */
  writtenDiffers: boolean | null
  /**
   * SHA-1 of the port's written cells (row, col, last value, $25 included),
   * 12 hex digits. Set when `differs` or `writtenDiffers`, and for a refusal,
   * where the port runs on a clean grid only to be pinned (#759); `threw:
   * <message>` plus the cells written before the throw is digested if it throws. Null for an agreeing run.
   */
  portDigest: string | null
}

/** Columns 0 and 15 put every screen-edge crossing on the first or last write. */
export const PLACEMENTS: readonly { col: number; rows: readonly number[] }[] = [
  { col: 3, rows: [2, 18, 10, 0, 26] },
  { col: 0, rows: [18, 2, 10, 0, 26] }, // lower half first, for rawA bit 4 and the +$100 pointer
  { col: 15, rows: [2, 18, 10, 0, 26] },
]
/** Screen 5, so objects that run left (diagonals, wide slopes) stay in the buffer. */
const SCREEN = 5
const GRID_SCREENS = 32

/** One tileset per distinct dispatcher, read from the ROM's own table. */
export function dispatcherTilesets(rom: RomFile): number[] {
  const ptrs = readLongPointerTable(rom, ADDR_TILESET_DISPATCH, TILESET_DISPATCH_COUNT)
  return ptrs.flatMap((p, ts) => (ptrs.indexOf(p) === ts ? [ts] : []))
}

export function caseCount(tilesets: number): number {
  return (tilesets * STANDARD_HANDLER_COUNT * 256 + EXTENDED_DISPATCH_COUNT) * PLACEMENTS.length
}

const cellOf = (addr: number) => {
  const o = (addr & 0xffff) - 0xc800
  const rem = o % 0x1b0
  return { plane: addr >>> 16, screen: Math.floor(o / 0x1b0), row: rem >> 4, col: rem & 15 }
}

/** Does `lower` (placed one row down) repeat `upper` exactly one row down? */
function translates(upper: BufferWrite[], lower: BufferWrite[]): boolean {
  if (upper.length !== lower.length) return false
  for (let i = 0; i < upper.length; i++) {
    const [a, b] = [cellOf(upper[i].addr), cellOf(lower[i].addr)]
    if (upper[i].value !== lower[i].value || a.plane !== b.plane || a.screen !== b.screen)
      return false
    if (a.col !== b.col || b.row !== a.row + 1) return false
  }
  return true
}

const digestOf = (writes: BufferWrite[]): string => {
  const h = createHash('sha1')
  for (const w of writes) h.update(`${w.addr},${w.value};`)
  return h.digest('hex').slice(0, 12)
}

/** Last value written to each cell, keyed row * 0x10000 + col. */
export type WrittenCells = Map<number, number>

/**
 * A blank grid whose row arrays record every index assignment. The grid is
 * pre-filled with TILE_EMPTY, so a write of $25 onto a $25 cell is invisible
 * in grid state; the record is what sees it. Reads and stored values are
 * unchanged. Not a sentinel fill: the port READS cells (peekExistingLow in
 * cursor.ts; standardHandlers.ts:3870 and :4906), so pre-filling with another
 * value would change what it writes. The Proxy has no get trap, and whole-grid
 * scans go through `raw`. Measured on L1Interpret.corpus.test.ts alone, one
 * machine, vanilla: about 172 s before #759, 228-234 s after (about +35%).
 */
export function recordedGrid(screens: number): {
  grid: TileGrid
  /** The same row arrays without the Proxy: whole-grid scans (compare) stay fast. */
  raw: TileGrid
  written: WrittenCells
} {
  const raw = createGrid(screens)
  const grid = raw.map(cells => cells)
  const written: WrittenCells = new Map()
  raw.forEach((cells, row) => {
    grid[row] = new Proxy(cells, {
      set(target, key, value) {
        const col = typeof key === 'string' ? Number(key) : NaN
        if (Number.isInteger(col) && col >= 0) written.set(row * 0x10000 + col, value as number)
        return Reflect.set(target, key, value)
      },
    })
  })
  return { grid, raw, written }
}

export const sameWritten = (a: WrittenCells, b: WrittenCells): boolean =>
  a.size === b.size && [...a].every(([k, v]) => b.get(k) === v)

/**
 * Digest of the cells the port wrote (last value each, in cell order), $25
 * included. A port that starts or stops writing $25 changes it; only each
 * cell's last value counts, not how often or in what order it was written.
 */
export const portDigestOf = (written: WrittenCells): string => {
  const h = createHash('sha1')
  for (const k of [...written.keys()].sort((a, b) => a - b))
    h.update(`${Math.floor(k / 0x10000)},${k % 0x10000},${written.get(k)};`)
  return h.digest('hex').slice(0, 12)
}

function sameGrid(a: TileGrid, b: TileGrid): boolean {
  for (let row = 0; row < a.length; row++) {
    const n = Math.max(a[row].length, b[row].length)
    for (let c = 0; c < n; c++)
      if ((a[row][c] ?? TILE_EMPTY) !== (b[row][c] ?? TILE_EMPTY)) return false
  }
  return true
}

/**
 * Compare only the 16 x 27 cells of one screen. An allow-list row for an
 * object that overruns its screen (#453) must not hide a difference on the
 * screen the object was placed on, only the spill past it.
 */
export function sameScreen(a: TileGrid, b: TileGrid, screen: number): boolean {
  for (let row = 0; row < SCREEN_H; row++)
    for (let c = screen * 16; c < screen * 16 + 16; c++)
      if ((a[row][c] ?? TILE_EMPTY) !== (b[row][c] ?? TILE_EMPTY)) return false
  return true
}

/** The per-case verdict sweep() records: whole-grid and own-screen-only. */
export function compareRun(port: TileGrid, mine: TileGrid) {
  return { differs: !sameGrid(port, mine), ownScreenDiffers: !sameScreen(port, mine, SCREEN) }
}

/** The port's and the interpreter's recorded grids, reused while a case leaves them untouched. */
export interface Rig {
  port: ReturnType<typeof recordedGrid>
  mine: ReturnType<typeof recordedGrid>
}
export const newRig = (): Rig => ({
  port: recordedGrid(GRID_SCREENS),
  mine: recordedGrid(GRID_SCREENS),
})

/**
 * One case's verdict, filled into `run`. `expand` draws the port's version of
 * the object onto the grid it is given (sweep passes expandObject). A refusal
 * runs the port only to pin it: a clean grid, its written cells digested (or
 * `threw: <message>` plus the cells written before the throw), then a reset
 * if anything was written. Otherwise the written-cell maps and grids are
 * compared and both grids reset after any write.
 */
export function stepCase(
  rig: Rig,
  run: DiffRun,
  r: Pick<InterpretResult, 'writes' | 'refusal'>,
  expand: (grid: TileGrid) => void,
): void {
  // The record is per case; the grids are reused only while untouched.
  rig.port.written.clear()
  rig.mine.written.clear()
  if (r.refusal) {
    try {
      expand(rig.port.grid)
      run.portDigest = portDigestOf(rig.port.written)
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      run.portDigest = createHash('sha1')
        .update(`threw: ${msg};${portDigestOf(rig.port.written)}`)
        .digest('hex')
        .slice(0, 12)
    }
    // A throw before any write leaves the grid clean; any write is recorded.
    if (rig.port.written.size > 0) rig.port = recordedGrid(GRID_SCREENS)
    return
  }
  expand(rig.port.grid)
  applyWrites(rig.mine.grid, r.writes)
  Object.assign(run, compareRun(rig.port.raw, rig.mine.raw))
  run.writtenDiffers = !sameWritten(rig.port.written, rig.mine.written)
  // Before the reset below: the record still holds this case's port output.
  if (run.differs || run.writtenDiffers) run.portDigest = portDigestOf(rig.port.written)
  if (run.differs || r.writes.length > 0 || rig.port.written.size > 0) {
    rig.port = recordedGrid(GRID_SCREENS)
    rig.mine = recordedGrid(GRID_SCREENS)
  }
}

export function sweep(rom: RomFile): DiffRun[] {
  const cases: [Kind, number, number, number][] = []
  for (const ts of dispatcherTilesets(rom))
    for (let o = 1; o <= STANDARD_HANDLER_COUNT; o++)
      for (let s = 0; s < 256; s++) cases.push(['standard', ts, o, s])
  for (let e = 0; e < EXTENDED_DISPATCH_COUNT; e++) cases.push(['extended', 0, e, e])

  const runs: DiffRun[] = []
  const rig = newRig()
  for (const { col, rows } of PLACEMENTS) {
    const x = SCREEN * 16 + col
    for (const [kind, ts, obj, size] of cases) {
      const at = (y: number): InterpretResult =>
        interpret(
          rom,
          kind === 'standard' ? ENTRY_STANDARD : ENTRY_EXTENDED,
          horizontalPlacement(kind, obj, size, x, y),
          { tileset: ts },
          { primitives: VANILLA_PRIMITIVES },
        )
      // Compare at the first row that fits, else the first that completes, else rows[0].
      const first: [number, InterpretResult] = [rows[0], at(rows[0])]
      let chosen: [number, InterpretResult] | null = null
      let completed: [number, InterpretResult] | null = null
      for (const y of rows) {
        const upper = y === rows[0] ? first[1] : at(y)
        if (upper.refusal) continue
        completed ??= [y, upper]
        const lower = y < 26 ? at(y + 1) : null
        if (lower && !lower.refusal && translates(upper.writes, lower.writes)) {
          chosen = [y, upper]
          break
        }
      }
      const fits = chosen !== null
      const [row, r] = chosen ?? completed ?? first
      const run: DiffRun = {
        kind,
        tileset: ts,
        obj,
        size,
        col,
        row,
        fits,
        leaf: r.dispatches[r.dispatches.length - 1] ?? 0,
        top: r.dispatches[kind === 'standard' ? 1 : 0] ?? 0,
        refusal: r.refusal?.reason ?? null,
        differs: null,
        ownScreenDiffers: null,
        writtenDiffers: null,
        digest: digestOf(r.writes),
        portDigest: null,
      }
      runs.push(run)
      const object = { type: kind, objectNumber: obj, settings: size, x, y: row } as LevelObject
      stepCase(rig, run, r, grid => expandObject(grid, object, rom, ts))
    }
  }
  return runs
}

export const hex6 = (a: number): string => '$' + a.toString(16).toUpperCase().padStart(6, '0')
export const caseName = (r: DiffRun): string =>
  `${r.kind} ts${r.tileset} $${r.obj.toString(16)} size $${r.size.toString(16)} col ${r.col} row ${r.row}`
