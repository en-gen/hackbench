/**
 * Ext object $5F (cave fill, ADDR_0DE971) through the real entry points (#362).
 *
 * ObjectExpander.test.ts drives the handler with `cur.vertical` set by hand,
 * which leaves the plumbing from `isVertical` to the cursor unproved. These go
 * through expandMapOwned and loadL2Objects, so dropping the flag at either call
 * site, or hard-coding it in makeCursor, turns a test red.
 *
 * Evidence scope: synthetic cart, handler pointer planted at the extended
 * dispatch table; vertical layout is SMWDisX trace only (no capture, no
 * differential). The table-derived test at the bottom needs the vanilla ROM.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { createGrid, expandMapOwned, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { loadL2Objects } from '../../../src/rom/L2Loader'
import {
  makeCursor,
  writeTile,
  SWITCH_FLAGS_UNCLEARED,
} from '../../../src/rom/objectHandlers/cursor'
import { handle_0DE971 } from '../../../src/rom/objectHandlers/extendedHandlers'
import { ADDR_EXTENDED_DISPATCH } from '../../../src/rom/objectHandlers/romData'
import type { LevelObject } from '../../../src/rom/LevelParser'
import { hasRom, freshRom } from '../support/corpus'
import { VANILLA } from '../support/corpus'

const off = (snes: number): number => ((snes >> 16) & 0x3f) * 0x8000 + (snes & 0x7fff)
const HANDLER = 0x0de971

function cart(edit: (buf: Buffer) => void = () => {}): RomFile {
  const buf = Buffer.alloc(0x80000, 0)
  buf[0x7fd5] = 0x20
  const at = off(ADDR_EXTENDED_DISPATCH + 0x5f * 3)
  buf.set([HANDLER & 0xff, (HANDLER >> 8) & 0xff, HANDLER >> 16], at)
  edit(buf)
  return new RomFile('synthetic.sfc', buf)
}

function ext5f(x: number, y: number): LevelObject {
  return {
    type: 'extended', screen: 0, x, y, objectNumber: 0x5f, settings: 0x5f, newScreen: false,
    highCoord: false, raw: [0, 0, 0x5f], streamOffset: 0, objectType: 0x15f, param: 0x5f,
  } // prettier-ignore
}

const count77 = (g: number[][]): number => g.flat().filter(t => t === 0x77).length

describe('ext $5F through expandMapOwned', () => {
  it('vertical level: the run is two vertical screens (both halves of each)', () => {
    const { grid } = expandMapOwned([ext5f(0, 0)], 2, cart(), 0, true, undefined, undefined, SWITCH_FLAGS_UNCLEARED, null) // prettier-ignore
    expect(grid.length).toBe(32)
    expect(count77(grid)).toBe(1024)
    expect(grid[16][0]).toBe(0x77)
    expect(grid[0][16]).toBe(0x77)
    expect(grid[31][31]).toBe(0x77)
  })

  it('horizontal level: same object, horizontal layout (432-byte screens)', () => {
    const { grid } = expandMapOwned([ext5f(0, 0)], 4, cart(), 0, false, undefined, undefined, SWITCH_FLAGS_UNCLEARED, null) // prettier-ignore
    expect(count77(grid)).toBe(1024)
    expect(grid[26][31]).toBe(0x77) // last cell of screen 1
    expect(grid[9][32 + 15]).toBe(0x77) // byte 1023: 432 + 432 + 160 into screen 2
    expect(grid[10][32]).toBe(TILE_EMPTY)
  })

  it('claims the cells it draws for the object', () => {
    const { owners } = expandMapOwned([ext5f(0, 0)], 2, cart(), 0, true, undefined, undefined, SWITCH_FLAGS_UNCLEARED, null) // prettier-ignore
    expect(owners.flat().filter(o => o === 0).length).toBe(1024)
  })
})

describe('ext $5F through loadL2Objects', () => {
  const stream = [0, 0, 0, 0, 0, 0x00, 0x00, 0x5f, 0xff]
  const l2 = (vertical: boolean) =>
    loadL2Objects(
      cart(b => b.set(stream, off(0x078000))),
      0x078000,
      2,
      0,
      vertical,
    )!.grid

  it('vertical L2: two vertical screens', () => {
    const grid = l2(true)
    expect(count77(grid)).toBe(1024)
    expect(grid[0][16]).toBe(0x77)
    expect(grid[31][31]).toBe(0x77)
  })

  it('horizontal L2 is unchanged by the vertical flag path', () => {
    const grid = l2(false)
    expect(grid.length).toBe(27)
    expect(count77(grid)).toBe(27 * 32) // 1024 bytes cover both screens (864 cells)
  })
})

describe('ext $5F clip is a fixed bound, not the rows an earlier object grew', () => {
  it('rows 4, 5 and 6 are treated alike at column 16 of a 1-screen level', () => {
    const grid = createGrid(1)
    const earlier = makeCursor(grid, cart(), 0, 16, 5, 1, 0)
    writeTile(earlier, 0x11) // grows row 5 to 17 columns
    expect(grid[5].length).toBe(17)
    const cur = makeCursor(grid, cart(), 0, 3, 2, 0x5f, 0)
    cur.handlerAddr = HANDLER
    handle_0DE971(cur)
    expect(grid[4].length).toBe(16)
    expect(grid[6].length).toBe(16)
    expect(grid[5].length).toBe(17)
    expect(grid[5][16]).toBe(0x11) // not drawn over: column 16 is outside the level
    expect(grid[4].every(t => t === 0x77)).toBe(true)
    expect(grid[5].slice(0, 16).every(t => t === 0x77)).toBe(true)
  })
})

// The oracle in ObjectExpander.test.ts shares the layout assumption with the
// handler. This one reads the strides out of the vanilla ROM's own tables.
describe.skipIf(!hasRom(VANILLA))(
  'ext $5F stride assumption checked against the vanilla LoadBlkPtrs tables',
  () => {
    const PTRS_L1 = 0x00bda8 // Ptrs00BDA8, bank_00.asm:6999
    const rom = hasRom(VANILLA) ? freshRom() : (null as unknown as RomFile)
    const entry = (table: number, s: number): number => {
      const b = rom.readAt(table + s * 3, 3)!
      return b[0] | (b[1] << 8) | (b[2] << 16)
    }
    const tableOf = (mode: number): number => rom.readWord(PTRS_L1 + mode * 2)!
    const VERTICAL_L1 = [3, 4, 7, 8, 10, 13] // VerticalTable bit 0 set (bank_05.asm:480-482)
    const HORIZONTAL_L1 = [0, 1, 2, 5, 6, 12, 14, 15]

    it.each(VERTICAL_L1)('mode %i: $200 per screen in the ROM table', mode => {
      const t = tableOf(mode)
      const origin = entry(0x00bad8, 0)
      for (let s = 0; s < 14; s++) expect(entry(t, s) - origin).toBe(s * 0x200)
    })

    it.each(HORIZONTAL_L1)('mode %i: $1B0 per screen, 16 screens', mode => {
      const t = tableOf(mode)
      const origin = entry(0x00bad8, 0)
      for (let s = 0; s < 16; s++) expect(entry(t, s) - origin).toBe(s * 0x1b0)
    })

    it('modes 3 and 4 break at screen 14 (not modelled)', () => {
      const origin = entry(0x00bad8, 0)
      expect(entry(tableOf(3), 14) - origin).toBe(0x1b00)
    })
  },
)
