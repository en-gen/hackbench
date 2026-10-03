/**
 * Four standard-object handlers draw a top row and then H body rows, H being
 * the size's high nibble (en-gen/hackbench#355, #356, #357, #358). The ports
 * drew H+1.
 *
 * Synthetic cart only, so this runs in CI where the corpus is absent. The cart
 * holds just the operands each port reads, at the offsets the port reads them,
 * with values that differ from vanilla so a port that hardcodes a tile goes red.
 *
 * Every size $00-$FF is swept and the WHOLE grid compared, so a stray row below
 * the last body row fails as surely as a missing one. The object sits at the
 * first column of screen 1, row 2, so no width wraps a screen edge.
 *
 * Loop counts traced in SMWDisX bank_0D.asm: 0DBA37:4371-4376 (0DBA0A),
 * 0DBA74:4408-4411 (0DBA4C), 0DEE45:8164-8169 (0DEE17), 0DEF87:8352-8354 (0DEF67).
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { loromToOffset } from '../../../src/rom/addressing'
import { createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { Cursor, makeCursor, TileGrid } from '../../../src/rom/objectHandlers/cursor'
import {
  handle_0DBA0A,
  handle_0DBA4C,
  handle_0DEE17,
  handle_0DEF67,
} from '../../../src/rom/objectHandlers/standardHandlers'
import { STANDARD_HANDLERS } from '../../../src/rom/objectHandlers/dispatch'

const COL = 16
const ROW = 2
const p1 = (lo: number): number => 0x100 | lo
const p0 = (lo: number): number => lo
const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]
const sizes = Array.from({ length: 256 }, (_, s) => s)

/** Each handler runs where the game has it and again at a relocated address. */
const RELOCATED = 0x0d9000

type Handler = (cur: Cursor) => void

/** A cart holding only the planted [SNES address, bytes] pairs. */
function cartWith(plants: [number, number[]][]): RomFile {
  const buf = Buffer.alloc(0x80000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode
  for (const [snes, bytes] of plants) buf.set(bytes, loromToOffset(snes, 0x80000)!)
  return new RomFile('synthetic.sfc', buf)
}

function run(rom: RomFile, handler: Handler, addr: number, objNo: number, size: number): TileGrid {
  const grid = createGrid(3)
  const cur = makeCursor(grid, rom, 0, COL, ROW, objNo, size)
  cur.handlerAddr = addr
  handler(cur)
  return grid
}

/** Expected grid: a top row, then H body rows, `width` cells wide, nothing else. */
function expected(
  width: number,
  H: number,
  top: (c: number) => number,
  body: (c: number) => number,
): TileGrid {
  const g = createGrid(3)
  for (let c = 0; c < width; c++) g[ROW][COL + c] = top(c)
  for (let r = 1; r <= H; r++) for (let c = 0; c < width; c++) g[ROW + r][COL + c] = body(c)
  return g
}

// [name, handler, vanilla address, object number, operand offsets, top tile, body tile, body page]
const CASES = [
  ['0DBA0A (std $35)', handle_0DBA0A, 0x0dba0a, 0x35, [24, 38], 0x71, 0x72, p0],
  ['0DEE17 (std $3D)', handle_0DEE17, 0x0dee17, 0x3d, [25, 39], 0x73, 0x74, p1],
  ['0DEF67 (std $32)', handle_0DEF67, 0x0def67, 0x32, [25, 48], 0x75, 0x76, p0],
] as const

describe.each(CASES)(
  '%s draws a top row and exactly H body rows (synthetic cart)',
  (_name, handler, vanilla, objNo, offs, topTile, bodyTile, bodyPage) => {
    it('is dispatched to the port', () => {
      expect(STANDARD_HANDLERS[vanilla]).toBe(handler)
    })

    describe.each([vanilla, RELOCATED])('handler at $%#x', addr => {
      // Operands exist only at `addr`, so a port that reads a fixed address reads zeros.
      const rom = cartWith([
        [addr + offs[0], [topTile]],
        [addr + offs[1], [bodyTile]],
      ])

      it('matches the routine for every size $00-$FF', () => {
        for (const size of sizes) {
          const got = run(rom, handler, addr, objNo, size)
          const want = expected(
            (size & 0x0f) + 1,
            size >> 4,
            () => p1(topTile),
            () => bodyPage(bodyTile),
          )
          expect(got, `size $${size.toString(16)}`).toEqual(want)
        }
      })

      it('size $00 draws the top row only, size $10 draws one body row', () => {
        const g0 = run(rom, handler, addr, objNo, 0x00)
        expect(g0[ROW][COL]).toBe(p1(topTile))
        expect(g0[ROW + 1][COL]).toBe(TILE_EMPTY)
        const g1 = run(rom, handler, addr, objNo, 0x10)
        expect(g1[ROW + 1][COL]).toBe(bodyPage(bodyTile))
        expect(g1[ROW + 2][COL]).toBe(TILE_EMPTY)
      })
    })
  },
)

describe('0DBA4C (std $34) draws a top tile and exactly H body tiles (synthetic cart)', () => {
  const VANILLA_ADDR = 0x0dba4c
  const T_TOP = 0x0d8100
  const T_BODY = 0x0d8200
  // Distinct per variant, unlike vanilla, so the index into each table shows.
  const top = Array.from({ length: 16 }, (_, i) => 0x20 + i)
  const body = Array.from({ length: 16 }, (_, i) => 0x40 + i)

  it('is dispatched to the port', () => {
    expect(STANDARD_HANDLERS[VANILLA_ADDR]).toBe(handle_0DBA4C)
  })

  describe.each([VANILLA_ADDR, RELOCATED])('handler at $%#x', addr => {
    const rom = cartWith([
      [addr + 19, long(T_TOP)],
      [addr + 35, long(T_BODY)],
      [T_TOP, top],
      [T_BODY, body],
    ])

    it('matches the routine for every size $00-$FF', () => {
      for (const size of sizes) {
        const X = size & 0x0f
        const got = run(rom, handle_0DBA4C, addr, 0x34, size)
        // Body tiles are page 1 only when X < 2 (CPX #$02 / BPL), else page 0.
        const want = expected(
          1,
          size >> 4,
          () => p1(top[X]),
          () => (X < 2 ? p1(body[X]) : p0(body[X])),
        )
        expect(got, `size $${size.toString(16)}`).toEqual(want)
      }
    })

    it('size $00 draws the top tile only, size $20 draws two body tiles', () => {
      const g0 = run(rom, handle_0DBA4C, addr, 0x34, 0x00)
      expect(g0[ROW][COL]).toBe(p1(top[0]))
      expect(g0[ROW + 1][COL]).toBe(TILE_EMPTY)
      const g2 = run(rom, handle_0DBA4C, addr, 0x34, 0x20)
      expect([g2[ROW + 1][COL], g2[ROW + 2][COL]]).toEqual([p1(body[0]), p1(body[0])])
      expect(g2[ROW + 3][COL]).toBe(TILE_EMPTY)
    })
  })
})
