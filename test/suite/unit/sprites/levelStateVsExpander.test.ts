/**
 * #649 step 2: pins WHERE the ROM-run level loader (LevelLoader.ts) and the TypeScript object
 * expander behind the map view (expandMap, as buildL1Inputs calls it) disagree on Layer 1 Map16.
 * Needs the ROM only. Measurement, not endorsement: a pinned map is a known difference.
 * Measured 2026-10-07, vanilla ROM, one machine, the 154 sprite-trace map ids (hex level numbers).
 *
 * Layout: screen-major, $1B0 bytes a screen (SMWDisX bank_00.asm:6595-6620, DATA_00BA60), a
 * screen row-major 16 wide (bank_00.asm:13295-13310: Y high nibble | X >> 4 | screen base).
 * Horizontal maps only; vertical ones are listed, not compared. Layer 1 is the first
 * `levelLength` screens (the table's L2 half starts at $1B00).
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

const IDS = '001 002 003 004 005 006 007 008 009 00a 00b 00c 00d 00e 00f 010 011 013 014 015 016 017 018 01a 01b 01c 01d 01f 020 021 022 023 024 093 094 095 096 097 098 099 09a 09b 0be 0bf 0c0 0c1 0c2 0c3 0c4 0c5 0c6 0c7 0c8 0c9 0ca 0cb 0cc 0cd 0ce 0cf 0d0 0d1 0d2 0d3 0d4 0d5 0d6 0d7 0d8 0d9 0db 101 102 103 104 105 106 107 109 10a 10b 10d 10e 10f 110 111 113 114 115 116 117 118 119 11a 11b 11c 11d 11e 11f 120 121 122 123 125 126 127 128 12a 12b 12c 12d 130 132 134 135 136 193 194 195 196 197 198 199 19a 19b 1bd 1be 1bf 1c0 1c1 1c2 1c3 1c4 1c5 1c6 1c7 1c8 1ca 1cc 1cd 1ce 1cf 1d0 1d1 1d2 1d3 1d4 1d5 1d6 1d7 1d8 1d9 1da 1db'.split(' ') // prettier-ignore
const VERTICAL = ['0c2', '0db', '109', '12a', '134', '1ce']
// 021: the loader writes $154 at screen 9 column 15, rows 0-6; the expander leaves $25.
// The 15 mode-9 boss arenas: the expander pre-fills rows 11 and 13 ($32, $05), the loader holds $25 there.
const DIFFERING = '021:7 095:32 096:16 097:16 098:32 099:32 09a:32 0cc:32 0d5:32 0d9:32 195:32 196:16 197:16 198:32 199:32 19a:32'.split(' ') // prettier-ignore

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
  return { grid, screens: Math.min(h.levelLength, 16), vertical }
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
    for (const id of IDS) {
      const e = expanded(rom, smw, id)
      if (e.vertical) { vertical.push(id); continue } // prettier-ignore
      const l = loadLevelState(rom, parseInt(id, 16))
      if (!l.ok) throw new Error(`${id}: ${l.reason}`)
      compared++
      const n = diffCells(l.wram, e.grid, e.screens)
      if (n) counts.push(`${id}:${n}`)
    }
    return (cached = { counts, vertical, compared })
  }

  it('the loader and the expander disagree on exactly the pinned maps, by differing-cell count', () => {
    expect(IDS.length).toBe(154)
    const r = real()
    expect(r.vertical).toEqual(VERTICAL)
    expect(r.compared).toBe(148)
    expect(r.counts).toEqual(DIFFERING) // 16 differ, so 132 of the 148 are identical
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
    w[0xc800 + 2 * SCREEN] = 1 // past the compared screens
    expect(diffCells(w, g, 2)).toBe(24)
  })
})
