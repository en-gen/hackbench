/**
 * resolveJsrTarget / resolveJmpTarget opcode gate (en-gen/hackbench#452).
 * Both read a 2-byte operand and take the bank from the opcode address, so a
 * hack that replaced the instruction made the port draw from garbage. Callers:
 * CODE_0DB49E (JSR at +19, JMP at +52) and ADDR_0DF066 (JMP at +2).
 *
 * Synthetic cart, so this runs in CI without the corpus. The port reads the
 * 65816 opcodes JSR abs = $20 and JMP abs = $4C (SMWDisX bank_0D.asm:3597,
 * 3614, 8477). A refusal draws nothing and is reported through the
 * sink and expandMapOwned's `refusals` (#301); CODE_0DDF3A's bare gates are not yet.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  createGrid,
  expandMap,
  SWITCH_FLAGS_UNCLEARED,
  TILE_EMPTY,
} from '../../../src/rom/ObjectExpander'
import { makeCursor } from '../../../src/rom/objectHandlers/cursor'
import {
  handle_0DB49E,
  handle_0DB571,
  handle_0DF066,
} from '../../../src/rom/objectHandlers/standardHandlers'

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
const STAMP = 0x0db571
const STAMP_TABLE = 0x0da300
const [PIPE_TILE, RECT_TILE, STAMP_TILE] = [0x0a, 0x82, 0x93]

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
  rom.writeAt(STAMP_TABLE, [STAMP_TILE])
  rom.writeAt(STAMP + 11, [0xbf, ...long(STAMP_TABLE)])
  rom.writeAt(FILL + 1, [0x02])
  rom.writeAt(FILL + 2, [JMP, ...word(RECT_CORE)])
  rom.writeAt(RECT_TABLE, [0x00, 0x00, RECT_TILE])
  rom.writeAt(RECT_CORE + 32, long(RECT_TABLE))
  return rom
}

const pathLine = (at: number, n: number): string =>
  `Object dispatch at ${hx(at, 6)} is not the stock routine, found ${Array(n).fill('00').join(' ')}: objects are drawn from the stock tables, not verified against this ROM.`
const hx = (n: number, w: number): string => '$' + n.toString(16).toUpperCase().padStart(w, '0')
/** The refusal line for a handler whose opcode at `opAt` was `found` rather than `want`. */
const refusal = (at: number, opAt: number, want: number, found: number): string =>
  `Handler ${hx(at, 6)} refused: the byte at ${hx(opAt, 6)} is ${hx(found, 2)}, not the ${hx(want, 2)} opcode it reads through, so the object is not drawn.`

type Handler = (c: ReturnType<typeof makeCursor>) => void

/** The drawn tiles (row-major, empties dropped) and every reason recorded. */
function run(handler: Handler, at: number, size: number, rom: RomFile, bare = false) {
  const grid = createGrid(1)
  const cur = makeCursor(grid, rom, 1, 4, 5, 0x25, size)
  cur.handlerAddr = at
  const unverified: string[] = []
  if (!bare) cur.draw = { vertical: false, unverified, primitives: [], draw: () => false }
  handler(cur)
  return { tiles: grid.flat().filter(t => t !== TILE_EMPTY), unverified }
}

// [name, handler, address, size, byte address of the gated opcode, tiles drawn]
const CALLERS = [
  ['0DB49E JSR (+19)', handle_0DB49E, PIPE, 0x10, PIPE + 19, [PIPE_TILE, PIPE_TILE]],
  ['0DB49E JMP (+52)', handle_0DB49E, PIPE, 0x10, BODY_LOOP + 18, [PIPE_TILE, PIPE_TILE]],
  ['0DF066 JMP (+2)', handle_0DF066, FILL, 0x11, FILL + 2, Array(4).fill(RECT_TILE)],
  ['0DB571 LDA.L (+11)', handle_0DB571, STAMP, 0x68, STAMP + 11, [STAMP_TILE]],
] as const

describe('opcode gates behind resolveJsrTarget, resolveJmpTarget and handle_0DB571 (#452)', () => {
  for (const [name, handler, at, size, opAt, drawn] of CALLERS) {
    it(`${name}: draws the expected tiles with the right opcode, no reason`, () => {
      const r = run(handler, at, size, cart())
      expect(r.tiles).toEqual(drawn)
      expect(r.unverified).toEqual([])
    })

    it(`${name}: every other opcode byte writes no tile and records one reason`, () => {
      const rom = cart()
      const good = rom.readByte(opAt)
      let swept = 0
      for (let op = 0; op < 0x100; op++) {
        if (op === good) continue
        rom.writeAt(opAt, [op])
        const r = run(handler, at, size, rom)
        expect(r.tiles, `opcode $${op.toString(16)}`).toEqual([])
        expect(r.unverified, `opcode $${op.toString(16)}`).toHaveLength(1)
        expect(r.unverified[0]).toBe(refusal(at, opAt, good, op))
        swept++
      }
      expect(swept).toBe(255)
    })

    it(`${name}: with no draw sink (null-sink callers) a refusal still draws nothing`, () => {
      const rom = cart()
      rom.writeAt(opAt, [0x22])
      expect(run(handler, at, size, rom, true).tiles).toEqual([])
    })
  }

  it('the issue witness through expandMap: LDX #2 : JSL $108000 at $0DF066', () => {
    const rom = cart()
    rom.writeAt(FILL, [0xa2, 0x02, 0x22, 0x00, 0x80, 0x10])
    // Tileset 0's dispatcher at $0DA500; its table, after the 10-byte preamble, routes object 1 here.
    rom.writeAt(0x0da41e, [0x00, 0xa5, 0x0d])
    rom.writeAt(0x0da500 + 10, [0x66, 0xf0, 0x0d])
    const obj = (y: number) => ({
      type: 'standard' as const,
      screen: 0,
      x: 1,
      y,
      objectNumber: 1,
      settings: 0x11,
      newScreen: false,
      highCoord: false,
      raw: [0, 0, 0x11],
      objectType: 1,
      param: 0x11,
    })
    const sink = { unverified: [] as string[], primitives: [], draw: () => false }
    const grid = expandMap([obj(2), obj(8)], 1, rom, 0, false, undefined, undefined, SWITCH_FLAGS_UNCLEARED, sink) // prettier-ignore
    expect(grid.flat().filter(t => t !== TILE_EMPTY)).toEqual([])
    // Two refused objects, one refusal line (deduped); the rest is notePath's findings.
    expect(sink.unverified).toEqual([
      pathLine(0x0da415, 9),
      pathLine(0x0da500, 10),
      refusal(FILL, FILL + 2, JMP, 0x22),
    ])
  })

  it('a gated byte past the end of the ROM is refused and reported as "nothing"', () => {
    const buf = Buffer.alloc(0x80000, 0)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('short.sfc', buf)
    const beyond = 0x3f8000 // file offset $1F8000, past the 512 KiB cart
    const r = run(handle_0DB571, beyond, 0x68, rom)
    expect(r.tiles).toEqual([])
    expect(r.unverified).toEqual([
      `Handler $3F8000 refused: the byte at $3F800B is nothing, not the $BF opcode it reads through, so the object is not drawn.`,
    ])
  })
})
