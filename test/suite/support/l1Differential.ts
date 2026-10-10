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
   * SHA-1 of the port's non-empty cells (row, col, tile) over the whole grid,
   * 12 hex digits. Null unless `differs`: an agreeing port needs no pin, and a
   * refusal never runs the port.
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

/** Skips TILE_EMPTY like sameGrid, so a port that starts or stops writing that tile is invisible. */
export const portDigestOf = (grid: TileGrid): string => {
  const h = createHash('sha1')
  grid.forEach((cells, row) =>
    cells.forEach((tile, col) => tile !== TILE_EMPTY && h.update(`${row},${col},${tile};`)),
  )
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

export function sweep(rom: RomFile): DiffRun[] {
  const cases: [Kind, number, number, number][] = []
  for (const ts of dispatcherTilesets(rom))
    for (let o = 1; o <= STANDARD_HANDLER_COUNT; o++)
      for (let s = 0; s < 256; s++) cases.push(['standard', ts, o, s])
  for (let e = 0; e < EXTENDED_DISPATCH_COUNT; e++) cases.push(['extended', 0, e, e])

  const runs: DiffRun[] = []
  let port = createGrid(GRID_SCREENS)
  let mine = createGrid(GRID_SCREENS)
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
        digest: digestOf(r.writes),
        portDigest: null,
      }
      runs.push(run)
      if (r.refusal) continue
      const object = { type: kind, objectNumber: obj, settings: size, x, y: row } as LevelObject
      expandObject(port, object, rom, ts)
      applyWrites(mine, r.writes)
      Object.assign(run, compareRun(port, mine))
      // Before the reset below: the grid still holds this case's port output.
      if (run.differs) run.portDigest = portDigestOf(port)
      if (run.differs || r.writes.length > 0)
        [port, mine] = [createGrid(GRID_SCREENS), createGrid(GRID_SCREENS)]
    }
  }
  return runs
}

export const hex6 = (a: number): string => '$' + a.toString(16).toUpperCase().padStart(6, '0')
export const caseName = (r: DiffRun): string =>
  `${r.kind} ts${r.tileset} $${r.obj.toString(16)} size $${r.size.toString(16)} col ${r.col} row ${r.row}`
