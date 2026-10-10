/**
 * #635: the ext $46 port's WRAM gates against the ROM's own handler, run
 * through the interpreter with the same RAM. Ties $13BF / $13CE / $1EA2 to the
 * real handler bytes (bank_0D.asm:1618-1633). Vanilla only; evidence scope:
 * the cases listed below, columns 0 and 5 of screen 5, row 10.
 */
import { describe, it, expect } from 'vitest'
import { hasRom, freshRom, VANILLA } from '../support/corpus'
import { createGrid, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { makeCursor, type TileGrid } from '../../../src/rom/objectHandlers/cursor'
import { handle_0DA68E } from '../../../src/rom/objectHandlers/extendedHandlers'
import {
  VANILLA_PRIMITIVES,
  ENTRY_EXTENDED,
  interpret,
  horizontalPlacement,
  applyWrites,
} from '../../../src/rom/objectHandlers/interpret'

const HANDLER_ADDR = 0x0da68e
const TRANSLEVEL = 0x13bf
const MIDWAY = 0x13ce
const SETTINGS = 0x1ea2
const SCREEN = 5
const ROW = 10

const cases: [string, [number, number][]][] = [
  ['no state', []],
  [
    'bit 6 set',
    [
      [TRANSLEVEL, 0x13],
      [SETTINGS + 0x13, 0x40],
    ],
  ],
  [
    'bit 7 set only',
    [
      [TRANSLEVEL, 0x13],
      [SETTINGS + 0x13, 0x80],
    ],
  ],
  ['MidwayFlag 1', [[MIDWAY, 1]]],
  ['MidwayFlag $FF', [[MIDWAY, 0xff]]],
  [
    'bit 6 on another translevel',
    [
      [TRANSLEVEL, 0x13],
      [SETTINGS + 0x14, 0x40],
    ],
  ],
  [
    '$13C0 witness',
    [
      [TRANSLEVEL, 0x13],
      [TRANSLEVEL + 1, 1],
      [SETTINGS + 0x13, 0x40],
    ],
  ],
]

const cells = (g: TileGrid): string[] =>
  g.flatMap((r, y) => r.flatMap((t, x) => (t === TILE_EMPTY ? [] : [`${y},${x}=${t}`])))

describe.skipIf(!hasRom(VANILLA))('ext $46 port vs the ROM handler, WRAM gates (#635)', () => {
  for (const [name, entries] of cases)
    for (const col of [0, 5]) {
      it(`${name}, column ${col}`, () => {
        const rom = freshRom(VANILLA)
        const ram = new Map(entries)
        const x = SCREEN * 16 + col
        const mine = createGrid(8)
        const r = interpret(
          rom,
          ENTRY_EXTENDED,
          horizontalPlacement('extended', 0x46, 0x46, x, ROW),
          { tileset: 0, ram },
          { primitives: VANILLA_PRIMITIVES },
        )
        expect(r.refusal).toBeNull()
        applyWrites(mine, r.writes)

        const port = createGrid(8)
        const cur = makeCursor(port, rom, 0, x, ROW, 0x46, 0)
        cur.handlerAddr = HANDLER_ADDR
        cur.ram = ram
        handle_0DA68E(cur)
        expect(cells(port)).toEqual(cells(mine))
        // Suppressed cases must draw nothing in both; the rest must draw something.
        const suppressed =
          name.startsWith('bit 6 set') || name.startsWith('MidwayFlag') || name.startsWith('$13C0')
        expect(cells(mine).length === 0).toBe(suppressed)
      })
    }
})
