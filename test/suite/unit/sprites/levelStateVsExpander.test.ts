/**
 * #649 step 2: pins WHERE the ROM-run level loader (LevelLoader.ts) and the TypeScript object
 * expander behind the map view (expandMap, as buildL1Inputs calls it) disagree on Layer 1 Map16.
 * Needs the ROM only. Measurement, not endorsement: a pinned map is a known difference.
 * Measured 2026-10-07, vanilla ROM, one machine, all 512 slots (hex ids). The loader runs with a fresh
 * save's switch flags, so the expander is called with SWITCH_FLAGS_UNCLEARED (the map view itself
 * passes the user's SwitchFlagsDto, project-server.ts:116-121).
 *
 * Layout: screen-major, $1B0 bytes a screen (SMWDisX bank_00.asm:6595-6628, DATA_00BA60 then DATA_00BA70, 32 entries), a
 * screen row-major 16 wide (bank_00.asm:13295-13310: Y high nibble | X >> 4 | screen base).
 * The sweep below compares horizontal maps only; vertical ones are listed there (#141 pins $0E7
 * separately). Layer 1 is the first `levelLength` screens, up to 32 (bank_00.asm:13299-13308 indexes
 * by screen up to LevelScrLength).
 */
import { describe, expect, it } from 'vitest'
import {
  isLevelModeVertical,
  parseLevelHeader,
  parseLevelObjects,
} from '../../../../src/rom/LevelParser'
import {
  expandMap,
  SWITCH_FLAGS_UNCLEARED,
  type TileGrid,
} from '../../../../src/rom/ObjectExpander'
import { VANILLA_PRIMITIVES } from '../../../../src/rom/objectHandlers/interpret'
import { drawInterpreted } from '../../../../src/rom/objectHandlers/interpretedDraw'
import type { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'

const SCREEN = 0x1b0

/**
 * Offset of grid cell (col, row) in the loader's Map16 tables. Horizontal: screen-major, $1B0 a
 * screen (bank_00.asm:13295-13310). Vertical: DATA_00BA80 layout, two screens side by side per 16
 * rows (bank_00.asm:13322-13340): (row>>4)*$200 + (col>>4)*$100 + (row&15)*16 + (col&15).
 */
function cellOffset(vertical: boolean, col: number, row: number): number {
  if (vertical) return (row >> 4) * 0x200 + (col >> 4) * 0x100 + (row & 15) * 16 + (col & 15)
  return (col >> 4) * SCREEN + row * 16 + (col & 15)
}

/**
 * Cells where the loader's wram (lo at $C800, hi at $1C800) differs from the expander's grid, as
 * [col, row] pairs. Horizontal compares 27 rows over `screens` screens; vertical compares
 * `screens` * 16 rows of 32 columns. A missing row or column is a difference, never a skip.
 */
function diffCellList(
  wram: Uint8Array,
  grid: TileGrid,
  screens: number,
  vertical: boolean,
): [number, number][] {
  const out: [number, number][] = []
  const rows = vertical ? screens * 16 : 27
  const cols = vertical ? 32 : screens * 16
  for (let y = 0; y < rows; y++)
    for (let x = 0; x < cols; x++) {
      const off = cellOffset(vertical, x, y)
      const got = (wram[0x1c800 + off]! << 8) | wram[0xc800 + off]!
      if (got !== (grid[y]?.[x] ?? -1)) out.push([x, y])
    }
  return out
}

/** Count of differing cells for a horizontal map over the first `screens` screens. */
function diffCells(wram: Uint8Array, grid: TileGrid, screens: number): number {
  return diffCellList(wram, grid, screens, false).length
}

const VERTICAL = '0c2 0db 0e7 0ea 0f7 108 109 12a 134 1ce 1ed'.split(' ')
// Boss arenas: the game-mode init writes rows the loader lacks (GM12, #707): 15 mode-9 maps (095 098 099 09a 0cc 0d5 0d9 0df 0e2 0e5 195 198 199 19a 1de; rows 11 and
// 13, 32 cells; the expander writes hi byte $00 where the ROM writes $32, bank_00.asm:3017-3020) and 6
// mode-$0B maps 096 097 196 197 1eb 1f6 (row 5 pre-filled $05, 16 cells). The capture is right on these.
// Mode-$10 Bowser maps 09b 19b 1c7: the ROM writes $3232 at row 12 of screens 0-1 (bank_00.asm:2925-2929
// -> 3014-3023); neither source does, so they are L=E and not pinned.
// 021 (7 cells) agreed once rows past the 27th wrapped into the next screen, as CODE_0DA97D does (#1034).
const DIFFERING = '095:32 096:16 097:16 098:32 099:32 09a:32 0cc:32 0d5:32 0d9:32 0df:32 0e2:32 0e5:32 195:32 196:16 197:16 198:32 199:32 19a:32 1de:32 1eb:16 1f6:16'.split(' ') // prettier-ignore

/** The map view's Layer 1 grid for a map: expandMap exactly as buildL1Inputs calls it (minus the L1-refusal for boss arenas). */
function expanded(
  rom: RomFile,
  smw: SmwRom,
  id: string,
): { grid: TileGrid; screens: number; vertical: boolean } {
  const table = smw.requireVerticalTable()
  const raw = smw.getLevelRawData(parseInt(id, 16))!
  const h = parseLevelHeader(raw)
  const vertical = isLevelModeVertical(h.levelMode, table)
  const { objects } = parseLevelObjects(raw, table)
  const grid = expandMap(objects, h.levelLength, rom, h.objectTileset, vertical, h.levelMode, undefined, SWITCH_FLAGS_UNCLEARED, { unverified: [], draw: drawInterpreted, primitives: VANILLA_PRIMITIVES }) // prettier-ignore
  return { grid, screens: h.levelLength, vertical }
}

describe.skipIf(!hasRom(VANILLA))('level loader vs map-view expander: Layer 1 Map16 (#649)', () => {
  let cached: { counts: string[]; vertical: string[]; compared: number } | undefined
  const real = () => {
    if (cached) return cached
    const rom = freshRom()
    const smw = new SmwRom(rom)
    const counts: string[] = []
    const vertical: string[] = []
    let compared = 0
    for (let n = 0; n < 512; n++) {
      const id = n.toString(16).padStart(3, '0')
      const e = expanded(rom, smw, id)
      if (e.vertical) { vertical.push(id); continue } // prettier-ignore
      const l = loadLevelState(rom, parseInt(id, 16))
      if (!l.ok) throw new Error(`${id}: ${l.reason}`)
      compared++
      const cells = diffCells(l.wram, e.grid, e.screens)
      if (cells) counts.push(`${id}:${cells}`)
    }
    return (cached = { counts, vertical, compared })
  }

  it('the loader and the expander disagree on exactly the pinned maps, by differing-cell count', () => {
    const r = real()
    expect(r.vertical).toEqual(VERTICAL)
    expect(r.compared).toBe(512 - VERTICAL.length)
    expect(r.counts).toEqual(DIFFERING)
  }, 300_000)

  it('a planted cell in an identical or a differing map, either source, goes red', () => {
    const rom = freshRom()
    const smw = new SmwRom(rom)
    for (const [id, base] of [
      ['004', 0],
      ['096', 16],
    ] as const) {
      const e = expanded(rom, smw, id)
      const l = loadLevelState(rom, parseInt(id, 16))
      if (!l.ok) throw new Error(l.reason)
      const w = l.wram.slice()
      w[0xc800] ^= 1 // loader, screen 0 cell (0,0) low table
      expect(diffCells(w, e.grid, e.screens)).toBe(base + 1)
      const g = e.grid.map(r => r.slice())
      g[1]![1] = (g[1]![1]! ^ 0x100) & 0x1ff // expander, hi bit
      expect(diffCells(l.wram, g, e.screens)).toBe(base + 1)
    }
  }, 300_000)
})

// #141 (family #144 #149 #150): the Sept map-diff fixtures were hand-played Mesen dumps carrying
// runtime state. On vanilla the expander equals the ROM's own loader on these slots, vertical $0E7 included.
const PINNED_AGREE = [
  ['1fe', '#141'],
  ['0e7', '#144 (vertical)'],
  ['1ef', '#149'],
  ['1e3', '#150'],
] as const

describe.skipIf(!hasRom(VANILLA))(
  'loader vs expander: slots named by #141, #144, #149, #150',
  () => {
    for (const [id, issue] of PINNED_AGREE)
      it(`slot $${id} (${issue}): 0 differing cells`, () => {
        const rom = freshRom()
        const e = expanded(rom, new SmwRom(rom), id)
        const l = loadLevelState(rom, parseInt(id, 16))
        if (!l.ok) throw new Error(l.reason)
        expect(e.vertical).toBe(id === '0e7')
        expect(diffCellList(l.wram, e.grid, e.screens, e.vertical)).toEqual([])
      }, 60_000)

    it('a planted cell in the loader wram or the grid is reported as exactly that cell, on each slot', () => {
      const rom = freshRom()
      const smw = new SmwRom(rom)
      for (const [id] of PINNED_AGREE) {
        const e = expanded(rom, smw, id)
        const l = loadLevelState(rom, parseInt(id, 16))
        if (!l.ok) throw new Error(l.reason)
        const [col, row] = [21, e.vertical ? 19 : 9]
        const w = l.wram.slice()
        w[0xc800 + cellOffset(e.vertical, col, row)] ^= 1
        expect(diffCellList(w, e.grid, e.screens, e.vertical)).toEqual([[col, row]])
        const g = e.grid.map(r => r.slice())
        g[row]![col] = (g[row]![col]! ^ 0x100) & 0x1ff
        expect(diffCellList(l.wram, g, e.screens, e.vertical)).toEqual([[col, row]])
      }
    }, 120_000)
  },
)

// No ROM needed: bytes built here, so these run in CI.
describe('cellOffset on hand-picked cells', () => {
  it('horizontal: screen-major, $1B0 a screen, 16 wide', () => {
    expect(cellOffset(false, 0, 0)).toBe(0)
    expect(cellOffset(false, 5, 3)).toBe(3 * 16 + 5)
    expect(cellOffset(false, 16, 0)).toBe(0x1b0)
    expect(cellOffset(false, 31, 26)).toBe(0x1b0 + 26 * 16 + 15)
  })
  it('vertical: 16 rows of two $100 halves per $200 block', () => {
    expect(cellOffset(true, 0, 0)).toBe(0)
    expect(cellOffset(true, 15, 15)).toBe(0xff)
    expect(cellOffset(true, 16, 0)).toBe(0x100)
    expect(cellOffset(true, 31, 15)).toBe(0x1ff)
    expect(cellOffset(true, 0, 16)).toBe(0x200)
    expect(cellOffset(true, 17, 35)).toBe(2 * 0x200 + 0x100 + 3 * 16 + 1)
  })
  it('diffCellList reports a planted vertical cell at its coordinates', () => {
    const w = new Uint8Array(0x30000)
    const g = Array.from({ length: 32 }, () => new Array(32).fill(0)) as TileGrid
    expect(diffCellList(w, g, 2, true)).toEqual([])
    w[0xc800 + cellOffset(true, 17, 20)] = 7
    expect(diffCellList(w, g, 2, true)).toEqual([[17, 20]])
  })
})

describe('diffCells on synthetic bytes', () => {
  const mk = () => ({ w: new Uint8Array(0x30000), g: Array.from({ length: 27 }, () => new Array(32).fill(0)) as TileGrid }) // prettier-ignore
  it('counts a planted cell in either table, in the second screen, and a missing column', () => {
    const { w, g } = mk()
    expect(diffCells(w, g, 2)).toBe(0)
    w[0xc800 + SCREEN + 3 * 16 + 5] = 0x25 // screen 1, row 3, column 5
    expect(diffCells(w, g, 2)).toBe(1)
    g[3]![16 + 5] = 0x25
    expect(diffCells(w, g, 2)).toBe(0)
    w[0x1c800 + 2] = 1 // hi table, screen 0 row 0 column 2
    expect(diffCells(w, g, 2)).toBe(1)
    g[0]![2] = 0x100
    expect(diffCells(w, g, 2)).toBe(0)
    expect(diffCells(w, g, 1)).toBe(0)
    g[26]!.length = 8 // the grid lacks the right-hand columns: 24 + 16 missing cells
    expect(diffCells(w, g, 2)).toBe(24)
    // Layer 1 runs to 32 screens: a cell on screen 17 must count (a 16-screen cap hid 34 maps).
    const far = mk()
    far.g.forEach((r, y) => (far.g[y] = new Array(18 * 16).fill(0)))
    expect(diffCells(far.w, far.g, 18)).toBe(0)
    far.w[0xc800 + 17 * SCREEN + 26 * 16 + 15] = 1
    expect(diffCells(far.w, far.g, 18)).toBe(1)
    expect(diffCells(far.w, far.g, 16)).toBe(0)
    w[0xc800 + 2 * SCREEN] = 1 // past the compared screens
    expect(diffCells(w, g, 2)).toBe(24)
  })
})
