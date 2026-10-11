/**
 * Ext $82, $83 (CODE_0DA71B, CODE_0DA760) and $84 (CODE_0DC2E9) on a synthetic
 * cart (#773). A $25 entry in their tables skips the low-byte store, but
 * StzTo6ePointer (bank_0D.asm:2112-2114) has already zeroed the cell's high
 * byte at [Map16HighPtr],Y, so the cell is still written: low byte kept, page 0
 * (call sites bank_0D.asm:1695, 1724; $84 skip bank_0D.asm:4804-4808). A port that only
 * sets its page leaves a page-1 cell under a skipped entry on page 1, and
 * leaves a blank cell unwritten where the interpreter writes $25.
 *
 * Tables, operands and tile values are invented; only the layout is the ROM's.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import {
  OWNER_NONE,
  makeCursor,
  type Cursor,
  type TileGrid,
} from '../../../src/rom/objectHandlers/cursor'
import {
  handle_0DA71B,
  handle_0DA760,
  handle_0DC2E9,
} from '../../../src/rom/objectHandlers/extendedHandlers'
import { recordedGrid, sameWritten, type WrittenCells } from '../support/l1Differential'

const off = (snes: number): number => ((snes >> 16) & 0x3f) * 0x8000 + (snes & 0x7fff)
const TABLE = 0x0d8100

interface Shape {
  name: string
  handler: (cur: Cursor) => void
  at: number // handler address
  operand: number // offset of the LDA.L table operand in the handler
  cols: number
  rows: number
  objNo: number
}
const SHAPES: Shape[] = [
  { name: '$82 CODE_0DA71B', handler: handle_0DA71B, at: 0x0da71b, operand: 23, cols: 9, rows: 5, objNo: 0x82 },
  { name: '$83 CODE_0DA760', handler: handle_0DA760, at: 0x0da760, operand: 23, cols: 6, rows: 4, objNo: 0x83 },
  { name: '$84 CODE_0DC2E9', handler: handle_0DC2E9, at: 0x0dc2e9, operand: 12, cols: 9, rows: 14, objNo: 0x84 },
] // prettier-ignore

/** Tile values below $49 so the hillside merge never alters them; every third entry is $25, never the last of a row. */
const tableFor = (s: Shape): number[] =>
  Array.from({ length: s.cols * s.rows }, (_, i) =>
    i % 3 === 1 && i % s.cols !== s.cols - 1 ? TILE_EMPTY : 0x30 + (i % 0x10),
  )

const cart = (s: Shape, table: number[] = tableFor(s)): RomFile => {
  const buf = Buffer.alloc(0x80000, 0x00)
  buf[0x7fd5] = 0x20
  buf.set([TABLE & 0xff, (TABLE >> 8) & 0xff, TABLE >> 16], off(s.at) + s.operand)
  buf.set(table, off(TABLE))
  return new RomFile('synthetic.sfc', buf)
}

const createGridRows = (): number => recordedGrid(4).raw.length
const COL = 20
const ROW = 3
const key = (row: number, col: number): number => row * 0x10000 + col
/** Grid position of table entry i. */
const cellOf = (s: Shape, i: number, row = ROW, col = COL): [number, number] => [
  row + Math.floor(i / s.cols),
  col + (i % s.cols),
]

interface Opts {
  prefill?: (g: TileGrid) => void
  row?: number
  col?: number
  table?: number[]
  rowLen?: number // truncate every grid row to this length first
}

function draw(s: Shape, o: Opts = {}) {
  const rec = recordedGrid(4)
  if (o.rowLen !== undefined) rec.raw.forEach(r => (r.length = o.rowLen!))
  o.prefill?.(rec.grid)
  rec.written.clear()
  const owners = rec.raw.map(r => r.map(() => OWNER_NONE))
  const cur = makeCursor(
    rec.grid,
    cart(s, o.table),
    0,
    o.col ?? COL,
    o.row ?? ROW,
    s.objNo,
    0,
    owners,
    7,
  )
  cur.handlerAddr = s.at
  s.handler(cur)
  return { ...rec, owners }
}

/** What the interpreter records on a blank grid: every footprint cell, a skipped entry as $25. */
function expectedBlank(s: Shape): WrittenCells {
  const t = tableFor(s)
  const m: WrittenCells = new Map()
  t.forEach((v, i) => m.set(key(...cellOf(s, i)), v))
  return m
}

describe.each(SHAPES)('$name: the high-byte store under a skipped entry (#773)', s => {
  it('writes the whole footprint on a blank grid, a $25 entry as $25', () => {
    const { written } = draw(s)
    expect(sameWritten(written, expectedBlank(s))).toBe(true)
  })
  it('sameWritten rejects a written map that lacks the $25 cells', () => {
    const skipping: WrittenCells = new Map(
      [...expectedBlank(s)].filter(([, v]) => v !== TILE_EMPTY),
    )
    expect(skipping.size).toBeLessThan(expectedBlank(s).size)
    expect(sameWritten(skipping, expectedBlank(s))).toBe(false)
  })
  it('clears the page of a page-1 cell under a $25 entry and keeps its low byte', () => {
    const t = tableFor(s)
    const i = t.indexOf(TILE_EMPTY)
    const [r, c] = cellOf(s, i)
    const { grid } = draw(s, { prefill: g => (g[r][c] = 0x141) })
    expect(grid[r][c]).toBe(0x041)
  })
  it('does not make the object the owner of a cell it left blank', () => {
    const t = tableFor(s)
    const i = t.indexOf(TILE_EMPTY)
    const { owners } = draw(s)
    const [r, c] = cellOf(s, i)
    expect(owners[r][c]).toBe(OWNER_NONE)
    expect(owners[ROW][COL]).toBe(7)
  })
  it('leaves the visible grid as it was on a blank grid', () => {
    const { raw } = draw(s)
    const t = tableFor(s)
    t.forEach((v, i) => {
      const [r, c] = cellOf(s, i)
      expect(raw[r][c]).toBe(v)
    })
    expect(raw[ROW][COL - 1]).toBe(TILE_EMPTY)
  })
  it.runIf(s.objNo === 0x84)(
    'stores a $25 in the 9th column as a normal write, replacing the prior cell',
    () => {
      const t = tableFor(s)
      const i = s.cols - 1 // last entry of footprint row 0
      t[i] = TILE_EMPTY
      const [r, c] = cellOf(s, i)
      const { grid } = draw(s, { table: t, prefill: g => (g[r][c] = 0x141) })
      expect(grid[r][c]).toBe(TILE_EMPTY) // a skipped store would keep $41
    },
  )
  it('does not write below the last grid row', () => {
    const last = createGridRows() - 1
    expect(() => draw(s, { row: last })).not.toThrow()
    const { written } = draw(s, { row: last })
    expect([...written.keys()].every(k => Math.floor(k / 0x10000) <= last)).toBe(true)
  })
  it('does not write at or past column $200', () => {
    const { written, raw } = draw(s, { col: 0x1fc })
    expect([...written.keys()].filter(k => k % 0x10000 >= 0x200)).toEqual([])
    expect(raw.every(r => r.length <= 0x200)).toBe(true)
  })
  it('pads a row shorter than the start column with $25, as writeTile does', () => {
    const t = tableFor(s)
    t[s.cols] = TILE_EMPTY // first entry of footprint row 1 is skipped
    const { raw } = draw(s, { table: t, rowLen: 10, col: 12 })
    const r = ROW + 1
    expect(raw[r].length).toBe(12 + s.cols)
    expect(Array.from({ length: 12 }, (_, c) => raw[r][c])).toEqual(Array(12).fill(TILE_EMPTY))
    expect(raw[r][12]).toBe(TILE_EMPTY)
  })
})
