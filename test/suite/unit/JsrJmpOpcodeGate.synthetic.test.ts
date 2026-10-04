/**
 * resolveJsrTarget / resolveJmpTarget opcode gate (en-gen/hackbench#452).
 * Both read a 2-byte operand and take the bank from the opcode address, so a
 * hack that replaced the instruction made the port draw from garbage. Callers:
 * CODE_0DB49E (JSR at +19, JMP at +52) and ADDR_0DF066 (JMP at +2).
 *
 * Synthetic cart, so this runs in CI without the corpus. The port reads the
 * 65816 opcodes JSR abs = $20 and JMP abs = $4C (SMWDisX bank_0D.asm:3597,
 * 3614, 8477). Until #301 gives the port a refusal channel, a refusal draws
 * nothing, the same as CODE_0DDF3A's gates.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { makeCursor } from '../../../src/rom/objectHandlers/cursor'
import { handle_0DB49E, handle_0DF066 } from '../../../src/rom/objectHandlers/standardHandlers'

const PIPE = 0x0db49e
const FILL = 0x0df066
const JSR = 0x20
const JMP = 0x4c
const BODY_LOOP = 0x0db4c0
const TOP = 0x0db4d9
const BOT = 0x0db4fe
const RECT_CORE = 0x0decce
const TILE_TABLE = 0x0da000
const RECT_TABLE = 0x0da200
const [PIPE_TILE, RECT_TILE] = [0x0a, 0x82]

function cart(): RomFile {
  const buf = Buffer.alloc(0x400000, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  const word = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff]
  const long = (a: number): number[] => [...word(a), a >> 16]
  rom.writeAt(TILE_TABLE, [PIPE_TILE])
  rom.writeAt(PIPE + 16, long(TILE_TABLE))
  rom.writeAt(PIPE + 19, [JSR, ...word(TOP)])
  rom.writeAt(BODY_LOOP + 18, [JMP, ...word(BOT)])
  for (const helper of [TOP, BOT]) {
    rom.writeAt(helper + 5, [0xff]) // triggers no tile in the grid
    rom.writeAt(helper + 16, [0xff])
  }
  rom.writeAt(FILL + 1, [0x02])
  rom.writeAt(FILL + 2, [JMP, ...word(RECT_CORE)])
  rom.writeAt(RECT_TABLE, [0x00, 0x00, RECT_TILE])
  rom.writeAt(RECT_CORE + 32, long(RECT_TABLE))
  return rom
}

function run(
  handler: (c: ReturnType<typeof makeCursor>) => void,
  at: number,
  size: number,
  rom: RomFile,
) {
  const grid = createGrid(1)
  const cur = makeCursor(grid, rom, 1, 4, 5, 0x25, size)
  cur.handlerAddr = at
  handler(cur)
  return grid.flat().filter(t => t !== TILE_EMPTY).length
}

// [name, handler, address, size, byte address of the gated opcode, tiles drawn]
const CALLERS = [
  ['0DB49E JSR (+19)', handle_0DB49E, PIPE, 0x10, PIPE + 19, 2],
  ['0DB49E JMP (+52)', handle_0DB49E, PIPE, 0x10, BODY_LOOP + 18, 2],
  ['0DF066 JMP (+2)', handle_0DF066, FILL, 0x11, FILL + 2, 4],
] as const

describe('JSR/JMP opcode gate (#452)', () => {
  for (const [name, handler, at, size, opAt, drawn] of CALLERS) {
    it(`${name}: draws with the right opcode`, () => {
      expect(run(handler, at, size, cart())).toBe(drawn)
    })

    it(`${name}: refuses every other opcode byte, draws nothing`, () => {
      const rom = cart()
      const good = rom.readByte(opAt)
      let swept = 0
      for (let op = 0; op < 0x100; op++) {
        if (op === good) continue
        rom.writeAt(opAt, [op])
        expect(run(handler, at, size, rom), `opcode $${op.toString(16)}`).toBe(0)
        swept++
      }
      expect(swept).toBe(255)
    })
  }

  it('the issue witness: LDX #2 : JSL $108000 at $0DF066 draws nothing', () => {
    const rom = cart()
    rom.writeAt(FILL, [0xa2, 0x02, 0x22, 0x00, 0x80, 0x10])
    expect(run(handle_0DF066, FILL, 0x11, rom)).toBe(0)
  })

  it('JSR and JMP are not interchangeable', () => {
    const rom = cart()
    rom.writeAt(PIPE + 19, [JMP])
    expect(run(handle_0DB49E, PIPE, 0x10, rom)).toBe(0)
    const rom2 = cart()
    rom2.writeAt(FILL + 2, [JSR])
    expect(run(handle_0DF066, FILL, 0x11, rom2)).toBe(0)
  })
})
