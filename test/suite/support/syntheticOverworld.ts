/**
 * A synthetic ROM the Overworld view can draw, built from nothing: the L1 and
 * L2 readers' pins and operands, GFX files and their read path, CODE_00AD25
 * and CODE_04DABA as NOPs (recognized by SYNTHETIC_FPS), a title screen map.
 *
 * Every address a reader reads through an operand is planted OFF its vanilla
 * location, so a reader that hardcodes OWL1TileData, OWL1CharData,
 * DATA_04DC02 or the L2 streams reads zeroes and fails.
 */
import { RomFile } from '../../../src/rom/RomFile'
import { encode } from '../../../src/rom/LcLz2'
import { ADDR } from '../../../src/rom/SmwRom'
import { OW_L1_READER } from '../../../src/rom/OverworldL1'
import { OW_L2_READER } from '../../../src/rom/OverworldL2'
import {
  OW_ADDR,
  OW_CGRAM_CODE,
  map16ByteOffset,
  tilemapByteOffset,
} from '../../../src/rom/OverworldLoader'
import { WILD } from '../../../src/rom/BytePattern'
import { GFX_FGBG_TABLE, GFX_FILE_COUNT } from '../../../src/rom/GfxLoader'
import { ADDR_BACK_AREA } from '../../../src/rom/PaletteLoader'
import { fingerprint } from '../../../src/rom/Fingerprint'
import { plantStockPaletteCol1 } from '../../../src/rom/PaletteStockTables'
import type { StockCode, StockSpan } from '../../../src/rom/SubmapFlagGate'
import type { WorkingRom } from '../../../src/project/WorkingRom'
import { FULL_WORD_MASK } from '../../../src/rom/PaletteOp'
import { TABLE_BANK, TABLE_HI, TABLE_LO, plantGfxReadPath } from './syntheticGfxCart'

export const TILE_DATA = 0x0d9000
export const CHAR_DATA = 0x0e8000
export const TILESET_TABLE = 0x04e000
export const BANK_SELECTS = [0x058a3c, 0x058b18]
const GFX_ARENA = 0x068000
export const TITLE_HEADER = 0x078000
/** The title map header's back area color index, and the color planted there. */
const BG_COLOR_INDEX = 3
export const BACKDROP_BGR = 0x1234

/** CODE_00AD25 and CODE_04DABA as planted here: NOPs, recognized by these fingerprints. */
export const SYNTHETIC_FPS = {
  cgram: [fingerprint(Buffer.alloc(0x81, 0xea))!],
  l2: [fingerprint(Buffer.alloc(0x35, 0xea))!],
}

export const le16 = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]
export const le24 = (v: number): number[] => [...le16(v), (v >> 16) & 0xff]
export const hex4 = (w: number): string => `$${w.toString(16).padStart(4, '0')}`

/** Appends a working-copy layer setting the word at `at` to `next(old)`. */
export function edit(working: WorkingRom, at: number, next: (old: number) => number): void {
  const old = RomFile.fromBytes('w', Buffer.from(working.bytes())).readWord(at)!
  working.append({
    id: `edit-${at.toString(16)}`,
    label: 'edit',
    ops: [{ address: hex4(at), old: hex4(old), new: hex4(next(old)), mask: FULL_WORD_MASK }],
  })
}

/** Every pinned (non-WILD) byte of a reader, with a value that must refuse. A
 *  bank byte ignores bit 7 (FastROM), so its flip keeps bit 7. */
export function pinnedFlips(
  reader: readonly (StockCode | StockSpan)[],
): { addr: number; value: number }[] {
  return reader.flatMap(c =>
    'bytes' in c
      ? c.bytes.flatMap((b, i) =>
          b === WILD ? [] : [{ addr: c.addr + i, value: b ^ (i === c.bankAt ? 0x7f : 0xff) }],
        )
      : [],
  )
}

function plantStock(rom: RomFile, reader: readonly (StockCode | StockSpan)[]): void {
  for (const c of reader) {
    rom.writeAt(
      c.addr,
      'bytes' in c ? c.bytes.map(b => (b === WILD ? 0 : b)) : Buffer.alloc(c.length, 0xea),
    )
  }
}

/** The L2 streams, in one bank off vanilla's: low bytes, then high bytes. */
export const L2_LO = 0x0c8000
export const L2_HI = 0x0ca100

/** The default L2 word: char $3F (solid), palette row 7, priority 0. */
export const L2_WORD = 0x3f | (7 << 10)
export const PRIO = 0x2000

/**
 * One high-priority word per quadrant of both layouts, each at a different
 * local position and in a different color (palette row, and solid char $3F or
 * the asymmetric $3E, whose pixel (2,2) is index 1). (y, x) are 8x8 cells.
 */
// prettier-ignore
export const L2_PROBES = [[3, 5], [7, 44], [41, 13], [50, 58], [9, 70], [20, 101], [36, 83], [60, 120]]
  .map(([y, x], i) => ({ y: y!, x: x!, row: 4 + (i & 3), char: i < 4 ? 0x3f : 0x3e }))
  .map(p => ({ ...p, word: p.char | (p.row << 10) | PRIO }))

/** Char $3E with each flip: its index-7 pixel lands at `at` within the cell. */
export const L2_FLIP_PROBES = [
  { y: 12, x: 20, flip: 0x4000, at: [7, 0] },
  { y: 12, x: 22, flip: 0x8000, at: [0, 7] },
  { y: 12, x: 24, flip: 0xc000, at: [7, 7] },
].map(p => ({ ...p, word: 0x3e | (6 << 10) | PRIO | p.flip }))

/** The default L2 tilemap: L2_WORD, the probes, and the flip probes. */
export function l2Tilemap(): Uint8Array {
  const t = new Uint8Array(0x4000)
  for (let i = 0; i < t.length; i += 2) t.set(le16(L2_WORD), i)
  for (const p of [...L2_PROBES, ...L2_FLIP_PROBES]) setL2Word(t, p.y, p.x, p.word)
  return t
}

/** Sets the word at 8x8 cell (x, y) of the canvas, layout = x >> 6. */
export function setL2Word(t: Uint8Array, y: number, x: number, word: number): void {
  t.set(le16(word), tilemapByteOffset((x >> 6) as 0 | 1, y, x & 63))
}

/** Byte length of one planted stream: 64 literal runs of 128, one command byte each. */
export const L2_STREAM_BYTES = 64 * 129

/** Writes `t` as the two streams (CODE_04DABA's literal cmd $7F) and points the operands at them. */
export function plantL2(rom: RomFile, t: Uint8Array, lo = L2_LO, hi = L2_HI): void {
  for (const [at, start] of [
    [lo, 0],
    [hi, 1],
  ] as const) {
    const out: number[] = []
    for (let i = start; i < t.length; i += 256) {
      out.push(0x7f)
      for (let k = i; k < i + 256; k += 2) out.push(t[k]!)
    }
    rom.writeAt(at, out)
  }
  rom.writeAt(0x04dc72, le16(lo))
  rom.writeAt(0x04dc79, [lo >> 16])
  rom.writeAt(0x04dc8d, le16(hi))
}

/** The tile index planted at grid (row 0-31, col 0-63); half 1 (col 32+) is offset by one so the halves differ. */
export const tileAt = (row: number, col: number): number => (row * 7 + col + (col >> 5)) & 0xff

export function plantBankSelect(
  rom: RomFile,
  at: number,
  lo: number,
  thr: number,
  hi: number,
): void {
  rom.writeAt(at, [0xa0, lo, 0xad, 0x31, 0x19, 0xc9, thr, 0x30, 0x02, 0xa0, hi, 0x84, 0x0c])
}

/**
 * GFX file i is 3bpp, $80 tiles: chars $00-$3F solid color (i % 7) + 1, except
 * $3E, which is index 7 at (0,0) and index 1 elsewhere; $40-$7F color 0.
 */
function plantGfx(rom: RomFile): void {
  plantGfxReadPath(rom)
  // 3bpp: 8 rows of (plane 0, plane 1), then 8 bytes of plane 2.
  const solid = (v: number): number[] => [
    ...[...Array(8)].flatMap(() => [v & 1 ? 0xff : 0, v & 2 ? 0xff : 0]),
    ...Array<number>(8).fill(v & 4 ? 0xff : 0),
  ]
  const asym = solid(1)
  asym[1] = 0x80 // row 0, plane 1: pixel (0,0)
  asym[16] = 0x80 // row 0, plane 2
  let at = GFX_ARENA
  for (let i = 0; i < GFX_FILE_COUNT; i++) {
    const tiles = [...Array(0x80)].flatMap((_, c) =>
      c === 0x3e ? asym : c < 0x40 ? solid((i % 7) + 1) : solid(0),
    )
    const stream = encode(Uint8Array.from(tiles))
    rom.writeAt(at, Buffer.from(stream))
    const snes = le24(at)
    rom.writeAt(TABLE_LO + i, [snes[0]!])
    rom.writeAt(TABLE_HI + i, [snes[1]!])
    rom.writeAt(TABLE_BANK + i, [snes[2]!])
    at += stream.length
  }
  // OBJECTGFXLIST: tileset t loads file t in every FG slot, so a tileset's
  // files are told apart by color index. Stops short of the L3 routine at $00A993.
  for (let t = 0; t < 0x18; t++) rom.writeAt(GFX_FGBG_TABLE + t * 4, [t, t, t, t])
}

/** The title screen map: `LDA #$EB : LDY #0 : STA $0109` naming slot $0C7, with
 *  back area color BG_COLOR_INDEX, whose color is BACKDROP_BGR. */
function plantTitleMap(rom: RomFile): void {
  rom.writeAt(0x0096cb, [0xa9, 0xeb, 0xa0, 0x00, 0x8d, 0x09, 0x01])
  rom.writeAt(ADDR.LEVEL_L1_PTR + 0xc7 * 3, le24(TITLE_HEADER))
  rom.writeAt(TITLE_HEADER + 1, [BG_COLOR_INDEX << 5])
  rom.writeAt(TITLE_HEADER + 5, [0xff])
  rom.writeAt(ADDR_BACK_AREA + BG_COLOR_INDEX * 2, le16(BACKDROP_BGR))
}

/** Palette index p's OverworldColors block paints color (p, row, col) in BGR555. */
function plantPalettes(rom: RomFile): void {
  for (let p = 0; p < 7; p++) {
    rom.writeAt(OW_ADDR.PALETTE_BLOCK_OFFSETS + p * 2, le16(p * 56))
    const words = [...Array(28)].map((_, k) => (p + 1) | ((k + 1) << 5))
    rom.writeAt(OW_ADDR.PALETTE_NORMAL_BASE + p * 56, words.flatMap(le16))
  }
  // DATA_00AD1E: slot s names palette index s.
  rom.writeAt(OW_ADDR.PALETTE_INDEX_TABLE, [0, 1, 2, 3, 4, 5, 6])
}

/** A 512 KB ROM the Overworld view can draw, with area 0's tileset `tileset`. */
export function syntheticOverworldRom(tileset = 0x12): RomFile {
  const buf = Buffer.alloc(0x80000, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  plantStock(rom, OW_L1_READER)
  rom.writeAt(0x04dc16, le24(TILESET_TABLE))
  rom.writeAt(0x04dc1d, [0x13])
  rom.writeAt(0x04dc3b, le16(CHAR_DATA))
  rom.writeAt(0x04dc5b, le16(TILE_DATA))
  rom.writeAt(0x04dc62, [TILE_DATA >> 16])
  rom.writeAt(TILESET_TABLE, [tileset])
  for (const at of BANK_SELECTS) plantBankSelect(rom, at, 0x0d, 0x10, CHAR_DATA >> 16)
  for (let row = 0; row < 32; row++)
    for (let col = 0; col < 64; col++)
      rom.writeAt(TILE_DATA + map16ByteOffset((col >> 5) as 0 | 1, row, col & 31), [
        tileAt(row, col),
      ])
  for (let i = 0; i < 256; i++) {
    // TL, BL, TR, BR words: char (i*4 + q) & $3F, palette row 4 + (i & 3).
    const words = [0, 1, 2, 3].map(q => ((i * 4 + q) & 0x3f) | ((4 + (i & 3)) << 10))
    rom.writeAt(CHAR_DATA + i * 8, words.flatMap(le16))
  }
  plantStock(rom, OW_CGRAM_CODE)
  plantStock(rom, OW_L2_READER)
  plantL2(rom, l2Tilemap())
  plantGfx(rom)
  plantTitleMap(rom)
  plantPalettes(rom)
  plantStockPaletteCol1(rom)
  return rom
}
