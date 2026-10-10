/**
 * CODE_0DBA4C and CODE_0DC3D8 read operands and a threshold from the handler's
 * own bytes (#519). A hack that rewrote the CPX #imm, the BPL or any opcode the
 * port reads through must change the output or refuse, never draw from vanilla
 * assumptions. CPX/BPL: bank_0D.asm:4402-4403 (CODE_0DBA67); loads 4398 and
 * 4406; CODE_0DC3D8 starts at bank_0D.asm:4933.
 *
 * Synthetic cart only (no ROM bytes), so this runs in CI.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { loromToOffset } from '../../../src/rom/addressing'
import { createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { makeCursor, TileGrid, Cursor } from '../../../src/rom/objectHandlers/cursor'
import { handle_0DBA4C, staircaseVariantB } from '../../../src/rom/objectHandlers/standardHandlers'

const COL = 16
const ROW = 2
const RELOCATED = 0x0d9000
const VANILLA_BA = 0x0dba4c
const VANILLA_C3 = 0x0dc3d8
const T_A = 0x0d8100
const T_B = 0x0d8200
const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]
const hx = (n: number, w: number): string => '$' + n.toString(16).toUpperCase().padStart(w, '0')
const refusal = (at: number, opAt: number, want: number, found: number): string =>
  `Handler ${hx(at, 6)} refused: the byte at ${hx(opAt, 6)} is ${hx(found, 2)}, not the ${hx(want, 2)} opcode it reads through, so the object is not drawn.`

function cartWith(plants: [number, number[]][]): RomFile {
  const buf = Buffer.alloc(0x80000, 0x00)
  buf[0x7fd5] = 0x20
  for (const [snes, bytes] of plants) buf.set(bytes, loromToOffset(snes, 0x80000)!)
  return new RomFile('synthetic.sfc', buf)
}

const top = Array.from({ length: 16 }, (_, i) => 0x20 + i)
const body = Array.from({ length: 16 }, (_, i) => 0x40 + i)

/** 0DBA4C's gated bytes: [offset, opcode]. */
const BA_PINS: [number, number][] = [
  [18, 0xbf],
  [27, 0xe0],
  [29, 0x10],
  [34, 0xbf],
]
const plantsBA = (addr: number, imm = 2): [number, number[]][] => [
  [addr + 18, [0xbf, ...long(T_A)]],
  [addr + 27, [0xe0, imm, 0x10]],
  [addr + 34, [0xbf, ...long(T_B)]],
  [T_A, top],
  [T_B, body],
]

const FILL = 0x7e
const cap = [0x60, 0x61, 0x62, 0x63]
const edge = [0x50, 0x51, 0x52, 0x53]
const C3_PINS: [number, number][] = [
  [30, 0xa9],
  [46, 0xbf],
  [60, 0xbf],
]
const plantsC3 = (addr: number): [number, number[]][] => [
  [addr + 30, [0xa9, FILL]],
  [addr + 46, [0xbf, ...long(T_B)]],
  [addr + 60, [0xbf, ...long(T_A)]],
  [T_A, cap],
  [T_B, edge],
]

function run(rom: RomFile, h: (c: Cursor) => void, addr: number, size: number) {
  const grid: TileGrid = createGrid(3)
  const cur = makeCursor(grid, rom, 0, COL, ROW, 0x34, size)
  cur.handlerAddr = addr
  const unverified: string[] = []
  cur.draw = { vertical: false, unverified, primitives: [], draw: () => false }
  h(cur)
  return { grid, unverified }
}

const blank = (): TileGrid => createGrid(3)
const replacements = (op: number): number[] =>
  [0x00, 0xff, op ^ 0x01, op ^ 0x80, 0xea, 0x20].filter((v, i, a) => v !== op && a.indexOf(v) === i)

describe('0DBA4C reads its CPX threshold from the CPX #imm (#519)', () => {
  const imms = [...Array.from({ length: 17 }, (_, i) => i), 0x7f, 0x80, 0xff]
  describe.each([VANILLA_BA, RELOCATED])('handler at $%#x', addr => {
    it('body page follows the flag rule ((X - imm) & $80) for every imm and X', () => {
      for (const imm of imms) {
        const rom = cartWith(plantsBA(addr, imm))
        for (let X = 0; X < 16; X++) {
          const { grid } = run(rom, handle_0DBA4C, addr, 0x10 | X)
          const page1 = ((X - imm) & 0x80) !== 0
          const want = page1 ? 0x100 | body[X] : body[X]
          expect(grid[ROW + 1][COL], `imm $${imm.toString(16)} X ${X}`).toBe(want)
        }
      }
    })

    it('a changed threshold changes the output versus imm=2', () => {
      const a = run(cartWith(plantsBA(addr, 2)), handle_0DBA4C, addr, 0x10).grid
      const b = run(cartWith(plantsBA(addr, 0)), handle_0DBA4C, addr, 0x10).grid
      expect(a[ROW + 1][COL]).toBe(0x100 | body[0])
      expect(b[ROW + 1][COL]).toBe(body[0])
    })
  })
})

describe.each([
  ['0DBA4C', handle_0DBA4C, VANILLA_BA, BA_PINS, plantsBA, 0x12],
  ['0DC3D8', staircaseVariantB, VANILLA_C3, C3_PINS, plantsC3, 0x21],
] as const)(
  '%s refuses when a pinned opcode changes (#519)',
  (_n, handler, vanilla, pins, plants, size) => {
    describe.each([vanilla, RELOCATED])('handler at $%#x', addr => {
      it('the unmodified cart draws something and refuses nothing', () => {
        const { grid, unverified } = run(cartWith(plants(addr)), handler, addr, size)
        expect(grid).not.toEqual(blank())
        expect(unverified).toEqual([])
      })

      for (const [off, op] of pins) {
        it(`byte at +${off} (expected $${op.toString(16)}): every replacement draws nothing and names the address`, () => {
          for (const found of replacements(op)) {
            const rom = cartWith([...plants(addr), [addr + off, [found]]])
            const { grid, unverified } = run(rom, handler, addr, size)
            expect(grid, `found $${found.toString(16)}`).toEqual(blank())
            expect(unverified).toEqual([refusal(addr, addr + off, op, found)])
          }
        })
      }
    })
  },
)

describe('refusal reads TILE_EMPTY everywhere (sanity)', () => {
  it('blank grid is all empty', () => {
    expect(blank().every(r => r.every(c => c === TILE_EMPTY))).toBe(true)
  })
})
