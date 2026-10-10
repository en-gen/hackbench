/**
 * Ext $82, $83 (CODE_0DA71B, CODE_0DA760) and $84 (CODE_0DC2E9) on a synthetic
 * cart (#773). A $25 entry in their tables skips the low-byte store, but
 * StzTo6ePointer (bank_0D.asm:2112-2114) has already zeroed the cell's high
 * byte at [Map16HighPtr],Y, so the cell is still written: low byte kept, page 0
 * (call sites bank_0D.asm:1696-1697, 1725-1726, 4797-4803). A port that only
 * sets its page leaves a page-1 cell under a skipped entry on page 1, and
 * leaves a blank cell unwritten where the interpreter writes $25.
 *
 * Tables, operands and tile values are invented; only the layout is the ROM's.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
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

const cart = (s: Shape): RomFile => {
  const buf = Buffer.alloc(0x80000, 0x00)
  buf[0x7fd5] = 0x20
  buf.set([TABLE & 0xff, (TABLE >> 8) & 0xff, TABLE >> 16], off(s.at) + s.operand)
  buf.set(tableFor(s), off(TABLE))
  return new RomFile('synthetic.sfc', buf)
}

const COL = 20
const ROW = 3
const key = (row: number, col: number): number => row * 0x10000 + col

function draw(s: Shape, prefill: (g: TileGrid) => void = () => {}) {
  const rec = recordedGrid(4)
  prefill(rec.grid)
  rec.written.clear()
  const owners = rec.raw.map(r => r.map(() => OWNER_NONE))
  const cur = makeCursor(rec.grid, cart(s), 0, COL, ROW, s.objNo, 0, owners, 7)
  cur.handlerAddr = s.at
  s.handler(cur)
  return { ...rec, owners }
}

/** What the interpreter records on a blank grid: every footprint cell, a skipped entry as $25. */
function expectedBlank(s: Shape): WrittenCells {
  const t = tableFor(s)
  const m: WrittenCells = new Map()
  t.forEach((v, i) => m.set(key(ROW + Math.floor(i / s.cols), COL + (i % s.cols)), v))
  return m
}

describe.each(SHAPES)('$name: the high-byte store under a skipped entry (#773)', s => {
  it('writes the whole footprint on a blank grid, a $25 entry as $25', () => {
    const { written } = draw(s)
    expect(sameWritten(written, expectedBlank(s))).toBe(true)
  })
  it('the comparison goes red on a skipping port: a map without the $25 cells differs', () => {
    const skipping: WrittenCells = new Map(
      [...expectedBlank(s)].filter(([, v]) => v !== TILE_EMPTY),
    )
    expect(skipping.size).toBeLessThan(expectedBlank(s).size)
    expect(sameWritten(skipping, expectedBlank(s))).toBe(false)
  })
  it('clears the page of a page-1 cell under a $25 entry and keeps its low byte', () => {
    const t = tableFor(s)
    const i = t.indexOf(TILE_EMPTY)
    const r = ROW + Math.floor(i / s.cols)
    const c = COL + (i % s.cols)
    const { grid } = draw(s, g => (g[r][c] = 0x141))
    expect(grid[r][c]).toBe(0x041)
  })
  it('does not make the object the owner of a cell it left blank', () => {
    const t = tableFor(s)
    const i = t.indexOf(TILE_EMPTY)
    const { owners } = draw(s)
    expect(owners[ROW + Math.floor(i / s.cols)][COL + (i % s.cols)]).toBe(OWNER_NONE)
    expect(owners[ROW][COL]).toBe(7)
  })
  it('leaves the visible grid as it was on a blank grid', () => {
    const { raw } = draw(s)
    const t = tableFor(s)
    t.forEach((v, i) => {
      expect(raw[ROW + Math.floor(i / s.cols)][COL + (i % s.cols)]).toBe(v)
    })
    expect(createGrid(4)[ROW][COL - 1]).toBe(TILE_EMPTY)
    expect(raw[ROW][COL - 1]).toBe(TILE_EMPTY)
  })
})
