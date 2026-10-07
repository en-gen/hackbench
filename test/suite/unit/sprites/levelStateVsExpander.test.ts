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
 * Horizontal maps only; vertical ones are listed, not compared. Layer 1 is the first
 * `levelLength` screens, up to 32 (bank_00.asm:13299-13308 indexes by screen up to LevelScrLength).
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

/** Loader cells (16-bit, hi table at $1C800) that differ from the expander's grid, over the first `screens` screens. */
function diffCells(wram: Uint8Array, grid: TileGrid, screens: number): number {
  let n = 0
  for (let s = 0; s < screens; s++)
    for (let y = 0; y < 27; y++)
      for (let x = 0; x < 16; x++) {
        const off = s * SCREEN + y * 16 + x
        const got = (wram[0x1c800 + off]! << 8) | wram[0xc800 + off]!
        // A missing row or column is a difference, never a skip.
        if (got !== (grid[y]?.[s * 16 + x] ?? -1)) n++
      }
  return n
}

const VERTICAL = '0c2 0db 0e7 0ea 0f7 108 109 12a 134 1ce 1ed'.split(' ')
// Boss arenas: the game-mode init writes rows the loader lacks (GM12, #707): 15 mode-9 maps (095 098 099 09a 0cc 0d5 0d9 0df 0e2 0e5 195 198 199 19a 1de; rows 11 and
// 13, 32 cells; the expander writes hi byte $00 where the ROM writes $32, bank_00.asm:3017-3020) and 6
// mode-$0B maps 096 097 196 197 1eb 1f6 (row 5 pre-filled $05, 16 cells). The capture is right on these.
// Mode-$10 Bowser maps 09b 19b 1c7: the ROM writes $3232 at row 12 of screens 0-1 (bank_00.asm:2925-2929
// -> 3014-3023); neither source does, so they are L=E and not pinned.
// 021 (7 cells): object $1F at x=143 y=18 size $FF, tileset 5, draws rows 18-33; CODE_0DA97D
// (bank_0D.asm:2018-2031) carries LevelLoadPos into the next screen with no row-27 check, and cursor.ts
// writeTile drops row >= grid.length. The loader is right, the expander is wrong (#300).
const DIFFERING = '021:7 095:32 096:16 097:16 098:32 099:32 09a:32 0cc:32 0d5:32 0d9:32 0df:32 0e2:32 0e5:32 195:32 196:16 197:16 198:32 199:32 19a:32 1de:32 1eb:16 1f6:16'.split(' ') // prettier-ignore

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
      ['021', 7],
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

// No ROM needed: bytes built here, so these run in CI.
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
