/**
 * CODE_0DBA4C and CODE_0DC3D8 read operands and a threshold from the handler's
 * own bytes (#519). A hack that rewrote the CPX #imm, the BPL or any opcode the
 * port reads through must change the output or refuse, never draw from vanilla
 * assumptions. CPX/BPL: bank_0D.asm:4403-4404 (CODE_0DBA67); loads 4398 and
 * 4406, AND #$0F at 4389; CODE_0DC3D8 starts at bank_0D.asm:4933.
 *
 * Synthetic cart only (no ROM bytes), so this runs in CI.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { loromToOffset } from '../../../src/rom/addressing'
import { createGrid } from '../../../src/rom/ObjectExpander'
import { makeCursor, TileGrid, Cursor } from '../../../src/rom/objectHandlers/cursor'
import {
  handle_0DB571,
  handle_0DBA4C,
  staircaseVariantB,
} from '../../../src/rom/objectHandlers/standardHandlers'
import { C3_FIXED, C3_JSRS, c3StructurePlants } from '../support/staircaseB'

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

const top = Array.from({ length: 32 }, (_, i) => 0x20 + i)
const body = Array.from({ length: 16 }, (_, i) => 0x40 + i)

/** 0DBA4C's gated bytes: [offset, opcode]. */
const BA_PINS: [number, number][] = [
  [4, 0x29],
  [18, 0xbf],
  [27, 0xe0],
  [29, 0x10],
  [30, 0x03],
  [34, 0xbf],
]
const plantsBA = (addr: number, imm = 2, mask = 0x0f): [number, number[]][] => [
  [addr + 4, [0x29, mask]],
  [addr + 18, [0xbf, ...long(T_A)]],
  [addr + 27, [0xe0, imm, 0x10, 0x03]],
  [addr + 34, [0xbf, ...long(T_B)]],
  [T_A, top],
  [T_B, body],
]

const FILL = 0x7e
const cap = [0x60, 0x61, 0x62, 0x63, 0x64, 0x65, 0x66, 0x67]
const edge = [0x50, 0x51, 0x52, 0x53]
const C3_PINS: [number, number][] = [
  [8, 0x29],
  [30, 0xa9],
  [46, 0xbf],
  [60, 0xbf],
  ...C3_FIXED.map(([off, op]): [number, number] => [off, op]),
  ...C3_JSRS.map(([off]): [number, number] => [off, 0x20]),
].sort((a, b) => a[0] - b[0])
const plantsC3 = (addr: number, mask = 0x03): [number, number[]][] => [
  [addr + 8, [0x29, mask]],
  [addr + 30, [0xa9, FILL]],
  [addr + 46, [0xbf, ...long(T_B)]],
  [addr + 60, [0xbf, ...long(T_A)]],
  ...c3StructurePlants(addr),
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

describe('X masks come from the AND #imm (#519)', () => {
  it('0DBA4C: AND #$07 at +5 makes size $0A read entry 2', () => {
    const { grid } = run(cartWith(plantsBA(RELOCATED, 2, 0x07)), handle_0DBA4C, RELOCATED, 0x1a)
    expect(grid[ROW][COL]).toBe(0x100 | top[2])
  })
  it('0DBA4C: AND #$1F at +5 makes size $1A read entry $1A (a hardcoded &$0F would read 10)', () => {
    const { grid } = run(cartWith(plantsBA(RELOCATED, 2, 0x1f)), handle_0DBA4C, RELOCATED, 0x1a)
    expect(grid[ROW][COL]).toBe(0x100 | top[0x1a])
  })
  it('0DC3D8: AND #$01 at +9 makes size $02 read entry 0', () => {
    const { grid } = run(cartWith(plantsC3(RELOCATED, 0x01)), staircaseVariantB, RELOCATED, 0x02)
    expect(grid[ROW][COL]).toBe(0x100 | cap[0])
  })
  it('0DC3D8: AND #$07 at +9 makes size $06 read cap entry 6 (a hardcoded &$03 would read 2)', () => {
    const { grid } = run(cartWith(plantsC3(RELOCATED, 0x07)), staircaseVariantB, RELOCATED, 0x06)
    expect(grid[ROW][COL]).toBe(0x100 | cap[6])
  })
})

describe('a pinned read just past the 512 KiB cart refuses with "nothing" (#519)', () => {
  it.each([
    ['0DBA4C', handle_0DBA4C, 4, 0x29],
    ['0DC3D8', staircaseVariantB, 8, 0x29],
  ] as const)('%s', (_n, handler, off, op) => {
    const addr = 0x108000 - off // the pinned read lands at $10:8000 = file offset 0x80000, the first byte past the cart
    const { grid, unverified } = run(cartWith([]), handler, addr, 0x12)
    expect(grid).toEqual(blank())
    expect(unverified).toHaveLength(1)
    expect(unverified[0]).toContain(`${hx(addr + off, 6)} is nothing, not the ${hx(op, 2)} opcode`)
  })
})

/**
 * A 448 KiB cart whose last readable byte is SNES $0D:FFFF (file offset 0x6FFFF), so a handler
 * ending there keeps bank $0D and its JSR targets match (#762); bytes planted past it are dropped.
 */
const LAST = 0x0dffff
function clippedCart(plants: [number, number[]][]): RomFile {
  const buf = Buffer.alloc(0x70000, 0x00)
  buf[0x7fd5] = 0x20
  for (const [snes, bytes] of plants) {
    const off = loromToOffset(snes, buf.length)
    if (off === null || off >= buf.length) continue
    buf.set(bytes.slice(0, buf.length - off), off)
  }
  return new RomFile('synthetic.sfc', buf)
}
const spanRefusal = (addr: number, operandAt: number): string =>
  `Handler ${hx(addr, 6)} refused: the required operand span at ${hx(operandAt, 6)} is outside the ROM, so the object is not drawn.`

describe('an opcode that matches but whose operand runs past the cart refuses (#519)', () => {
  it.each([
    ['0DBA4C', handle_0DBA4C, plantsBA, 0x12, BA_PINS.filter(([o]) => o !== 30)],
    ['0DC3D8', staircaseVariantB, plantsC3, 0x21, C3_PINS],
  ] as const)(
    '%s: every gated opcode with an operand, as the last readable byte',
    (_n, handler, plants, size, pins) => {
      for (const [off, op] of pins) {
        const addr = LAST - off
        const { grid, unverified } = run(clippedCart(plants(addr)), handler, addr, size)
        expect(grid, `+${off}`).toEqual(blank())
        expect(unverified, `+${off}`).toEqual([spanRefusal(addr, LAST + 1)])
        expect(op).toBeGreaterThan(0)
      }
    },
  )

  it('0DB571: the $BF long-load as the last readable byte', () => {
    const addr = LAST - 11
    const { grid, unverified } = run(clippedCart([[LAST, [0xbf]]]), handle_0DB571, addr, 0x68)
    expect(grid).toEqual(blank())
    expect(unverified).toEqual([spanRefusal(addr, LAST + 1)])
  })
})

const operandRefusal = (addr: number, at: number, want: number, found: number): string =>
  `Handler ${hx(addr, 6)} refused: the operand at ${hx(at, 6)} is ${hx(found, 2)}, not the ${hx(want, 2)} the port assumes, so the object is not drawn.`
const jsrRefusal = (addr: number, at: number, want: number, found: number): string =>
  `Handler ${hx(addr, 6)} refused: the JSR at ${hx(at, 6)} calls ${hx(found, 6)}, not ${hx(want, 6)} as the port assumes, so the object is not drawn.`

describe('0DC3D8 refuses when a hard-coded operand or JSR target changes (#762)', () => {
  describe.each([VANILLA_C3, RELOCATED])('handler at $%#x', addr => {
    for (const [off, , operand] of C3_FIXED) {
      it(`operand at +${off + 1} (expected $${operand.toString(16)}): every replacement draws nothing and names the address`, () => {
        for (const found of replacements(operand)) {
          const rom = cartWith([...plantsC3(addr), [addr + off + 1, [found]]])
          const { grid, unverified } = run(rom, staircaseVariantB, addr, 0x21)
          expect(grid, `found $${found.toString(16)}`).toEqual(blank())
          expect(unverified).toEqual([operandRefusal(addr, addr + off + 1, operand, found)])
        }
      })
    }

    for (const [off, target] of C3_JSRS) {
      it(`JSR at +${off} (expected $${target.toString(16)}): a retargeted low or high byte draws nothing`, () => {
        for (const half of [0, 1]) {
          const want = (target >> (8 * half)) & 0xff
          for (const b of replacements(want)) {
            const found = (target & ~(0xff << (8 * half))) | (b << (8 * half))
            const rom = cartWith([...plantsC3(addr), [addr + off + 1 + half, [b]]])
            const { grid, unverified } = run(rom, staircaseVariantB, addr, 0x21)
            expect(grid, `byte ${half} = $${b.toString(16)}`).toEqual(blank())
            expect(unverified).toEqual([jsrRefusal(addr, addr + off, target, found)])
          }
        }
      })
    }
  })

  it('a handler moved out of bank $0D with vanilla operands calls that bank, so it refuses', () => {
    for (const addr of [0x0e9000, 0x0c9000, 0x8e9000]) {
      const { grid, unverified } = run(cartWith(plantsC3(addr)), staircaseVariantB, addr, 0x21)
      expect(grid).toEqual(blank())
      expect(unverified).toEqual([
        jsrRefusal(addr, addr + 11, 0x0da6b1, (addr & 0xff0000) | 0xa6b1),
      ])
    }
  })

  it('a handler in the FastROM mirror of bank $0D ($8D) calls the same routines, so it draws', () => {
    const addr = 0x8d9000
    const { grid, unverified } = run(cartWith(plantsC3(addr)), staircaseVariantB, addr, 0x21)
    expect(grid).not.toEqual(blank())
    expect(unverified).toEqual([])
  })
})
