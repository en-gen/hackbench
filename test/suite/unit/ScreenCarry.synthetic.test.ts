/**
 * Layer 1 row advance past row 26 (en-gen/hackbench#300).
 *
 * CODE_0DA97D (SMWDisX bank_0D.asm:2018-2031) adds $10 to LevelLoadPos and
 * carries into the next screen with no row-27 check, so a horizontal screen's
 * $1B0 bytes spill linearly: row 27 is the next screen's row 0, 16 columns on.
 * Vertical levels use another stride and keep the flat row count.
 *
 * Synthetic only (no ROM). The $1F-shaped object plants the three operands
 * handle_0DB51F reads (tiles at +15, +23, +36) with values that differ from
 * vanilla; the cart is otherwise zeroes.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { loromToOffset } from '../../../src/rom/addressing'
import { createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { advanceRowRaw, makeCursor, nextRow } from '../../../src/rom/objectHandlers/cursor'
import { handle_0DB51F } from '../../../src/rom/objectHandlers/standardHandlers'

function cartWith(plants: [number, number[]][]): RomFile {
  const buf = Buffer.alloc(0x80000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode
  for (const [snes, bytes] of plants) buf.set(bytes, loromToOffset(snes, 0x80000)!)
  return new RomFile('synthetic.sfc', buf)
}

describe('cursor.ts screen carry (CODE_0DA97D)', () => {
  const rom = cartWith([])

  it('advanceRowRaw from row 26 on a horizontal grid lands at row 0, col + 16', () => {
    const cur = makeCursor(createGrid(3), rom, 0, 15, 26, 0, 0)
    advanceRowRaw(cur)
    expect([cur.row, cur.col]).toEqual([0, 31])
  })

  it('does not carry before row 26', () => {
    const cur = makeCursor(createGrid(3), rom, 0, 15, 25, 0, 0)
    advanceRowRaw(cur)
    expect([cur.row, cur.col]).toEqual([26, 15])
  })

  it('nextRow carries and moves the bookmark, so later rows stay on the next screen', () => {
    const cur = makeCursor(createGrid(3), rom, 0, 15, 26, 0, 0)
    cur.bookmarkCol = 15
    nextRow(cur)
    expect([cur.row, cur.col, cur.bookmarkCol]).toEqual([0, 31, 31])
    nextRow(cur)
    expect([cur.row, cur.col]).toEqual([1, 31])
  })

  it('a vertical level does not carry', () => {
    const cur = makeCursor(createGrid(3, true), rom, 0, 15, 26, 0, 0, null, -1, undefined, true)
    advanceRowRaw(cur)
    expect([cur.row, cur.col]).toEqual([27, 15])
  })
})

describe('handle_0DB51F past row 26 (#300)', () => {
  const ADDR = 0x0db51f
  const rom = cartWith([
    [ADDR + 15, [0x53]],
    [ADDR + 23, [0x54]],
    [ADDR + 36, [0x55]],
  ])

  // #300: flips to a plain it() once handle_0DB51F advances through advanceRowRaw (CODE_0DA97D, bank_0D.asm:2018-2031)
  it.fails('size $FF from row 18 lands rows 0-6 on the next screen at col + 16', () => {
    const grid = createGrid(3)
    const cur = makeCursor(grid, rom, 5, 15, 18, 0x1f, 0xff)
    cur.handlerAddr = ADDR
    handle_0DB51F(cur)
    // Rows 18-26 on screen 0 (top, 8 middles), then 7 more cells on screen 1 (6 middles, bottom).
    expect(grid[18][15]).toBe(0x153)
    expect(grid[26][15]).toBe(0x154)
    expect(grid.slice(0, 6).map(r => r[31])).toEqual(Array(6).fill(0x154))
    expect(grid[6][31]).toBe(0x155)
    expect(grid[7][31]).toBe(TILE_EMPTY)
  })
})
