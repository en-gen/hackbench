/**
 * A synthetic ROM the Overworld view can draw, built from nothing: the L1 and
 * L2 readers' pins and operands, GFX files and their read path, CODE_00AD25
 * and CODE_04DABA as NOPs (recognized by the SYNTHETIC_* fingerprints), a
 * title screen map.
 *
 * Every address the L1 reader reads through an operand is planted OFF its
 * vanilla location, so a reader that hardcodes OWL1TileData, OWL1CharData or
 * DATA_04DC02 reads zeroes and fails.
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
import { fingerprint } from '../../../src/rom/Fingerprint'
import { plantStockPaletteCol1 } from '../../../src/rom/PaletteStockTables'
import { TABLE_BANK, TABLE_HI, TABLE_LO, plantGfxReadPath } from './syntheticGfxCart'

export const TILE_DATA = 0x0d9000
export const CHAR_DATA = 0x0e8000
export const TILESET_TABLE = 0x04e000
export const BANK_SELECTS = [0x058a3c, 0x058b18]
const GFX_ARENA = 0x068000
export const TITLE_HEADER = 0x078000
const CGRAM_SPAN = 0x81

/** CODE_00AD25 as planted here: NOPs, recognized by this fingerprint. */
export const SYNTHETIC_CGRAM_FINGERPRINT = [fingerprint(Buffer.alloc(CGRAM_SPAN, 0xea))!]
/** CODE_04DABA likewise. */
export const SYNTHETIC_L2_FINGERPRINT = [fingerprint(Buffer.alloc(0x35, 0xea))!]
export const SYNTHETIC_FPS = { cgram: SYNTHETIC_CGRAM_FINGERPRINT, l2: SYNTHETIC_L2_FINGERPRINT }

/** The L2 streams, in one bank off vanilla's: low bytes, then high bytes. */
export const L2_LO = 0x0c8000
export const L2_HI = 0x0ca100

/** An L2 tilemap word: char $3F (opaque), palette row 7, priority 0. */
export const L2_WORD = 0x3f | (7 << 10)

/** The default L2 tilemap: L2_WORD everywhere. */
export function l2Tilemap(): Uint8Array {
  const t = new Uint8Array(0x4000)
  for (let i = 0; i < t.length; i += 2) t.set([L2_WORD & 0xff, L2_WORD >> 8], i)
  return t
}

/** Sets the word at 8x8 cell (x, y) of the canvas, layout = x >> 6. */
export function setL2Word(t: Uint8Array, y: number, x: number, word: number): void {
  t.set([word & 0xff, word >> 8], tilemapByteOffset((x >> 6) as 0 | 1, y, x & 63))
}

/** Writes `t` as the two streams, literal runs of 128 (CODE_04DABA's cmd $7F). */
export function plantL2(rom: RomFile, t: Uint8Array): void {
  for (const [at, start] of [
    [L2_LO, 0],
    [L2_HI, 1],
  ] as const) {
    const out: number[] = []
    for (let i = start; i < t.length; i += 256) {
      out.push(0x7f)
      for (let k = i; k < i + 256; k += 2) out.push(t[k]!)
    }
    out.push(0xff) // one byte past the end, so the stream never ends at the read's edge
    rom.writeAt(at, out)
  }
}

/** The tile index planted at grid (row 0-31, col 0-63), half 0 on the left. */
export const tileAt = (row: number, col: number): number => (row * 7 + col) & 0xff

export function plantBankSelect(
  rom: RomFile,
  at: number,
  lo: number,
  thr: number,
  hi: number,
): void {
  rom.writeAt(at, [0xa0, lo, 0xad, 0x31, 0x19, 0xc9, thr, 0x30, 0x02, 0xa0, hi, 0x84, 0x0c])
}

/** GFX file i is 3bpp, $80 tiles: chars $00-$3F solid color (i % 7) + 1, $40-$7F color 0. */
function plantGfx(rom: RomFile): void {
  plantGfxReadPath(rom)
  let at = GFX_ARENA
  for (let i = 0; i < GFX_FILE_COUNT; i++) {
    // 3bpp: planes 0-1 interleaved, then plane 2; a solid index sets whole bytes.
    const v = (i % 7) + 1
    const tile = [...Array(8)].flatMap(() => [v & 1 ? 0xff : 0, v & 2 ? 0xff : 0])
    const tile3 = [...tile, ...Array(8).fill(v & 4 ? 0xff : 0)]
    const bytes = Uint8Array.from({ length: 0x80 * 24 }, (_, k) =>
      k < 0x40 * 24 ? tile3[k % 24]! : 0,
    )
    const stream = encode(bytes)
    rom.writeAt(at, Buffer.from(stream))
    rom.writeAt(TABLE_LO + i, [at & 0xff])
    rom.writeAt(TABLE_HI + i, [(at >> 8) & 0xff])
    rom.writeAt(TABLE_BANK + i, [at >> 16])
    at += stream.length
  }
  // OBJECTGFXLIST: tileset t loads file t in every FG slot, so a tileset's
  // files are told apart by color index. Stops short of the L3 routine at $00A993.
  for (let t = 0; t < 0x18; t++) rom.writeAt(GFX_FGBG_TABLE + t * 4, [t, t, t, t])
}

/** The title screen map: `LDA #$EB : LDY #0 : STA $0109` naming slot $0C7, header all zero. */
function plantTitleMap(rom: RomFile): void {
  rom.writeAt(0x0096cb, [0xa9, 0xeb, 0xa0, 0x00, 0x8d, 0x09, 0x01])
  rom.writeAt(ADDR.LEVEL_L1_PTR + 0xc7 * 3, [0x00, 0x80, 0x07])
  rom.writeAt(TITLE_HEADER + 5, [0xff])
}

/** Palette index p's OverworldColors block paints color (p, row, col) in BGR555. */
function plantPalettes(rom: RomFile): void {
  for (let p = 0; p < 7; p++) {
    rom.writeAt(OW_ADDR.PALETTE_BLOCK_OFFSETS + p * 2, [(p * 56) & 0xff, (p * 56) >> 8])
    const words = [...Array(28)].map((_, k) => (p + 1) | ((k + 1) << 5))
    rom.writeAt(
      OW_ADDR.PALETTE_NORMAL_BASE + p * 56,
      words.flatMap(w => [w & 0xff, w >> 8]),
    )
  }
  // DATA_00AD1E: slot s names palette index s.
  rom.writeAt(OW_ADDR.PALETTE_INDEX_TABLE, [0, 1, 2, 3, 4, 5, 6])
}

/** A 512 KB ROM the Overworld view can draw, with area 0's tileset `tileset`. */
export function syntheticOverworldRom(tileset = 0x12): RomFile {
  const buf = Buffer.alloc(0x80000, 0)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  for (const c of OW_L1_READER) rom.writeAt(c.addr, [...c.bytes])
  rom.writeAt(0x04dc16, [TILESET_TABLE & 0xff, (TILESET_TABLE >> 8) & 0xff, TILESET_TABLE >> 16])
  rom.writeAt(0x04dc1d, [0x13])
  rom.writeAt(0x04dc3b, [CHAR_DATA & 0xff, (CHAR_DATA >> 8) & 0xff])
  rom.writeAt(0x04dc5b, [TILE_DATA & 0xff, (TILE_DATA >> 8) & 0xff])
  rom.writeAt(0x04dc62, [TILE_DATA >> 16])
  rom.writeAt(TILESET_TABLE, [tileset])
  for (const at of BANK_SELECTS) plantBankSelect(rom, at, 0x0d, 0x10, CHAR_DATA >> 16)
  for (let row = 0; row < 32; row++)
    for (let col = 0; col < 64; col++)
      rom.writeAt(TILE_DATA + map16ByteOffset((col >> 5) as 0 | 1, row, col & 31), [
        tileAt(row, col),
      ])
  for (let i = 0; i < 256; i++) {
    // TL, BL, TR, BR words: opaque char (i*4 + q) & $3F, palette row 4 + (i & 3).
    const words = [0, 1, 2, 3].map(q => ((i * 4 + q) & 0x3f) | ((4 + (i & 3)) << 10))
    rom.writeAt(
      CHAR_DATA + i * 8,
      words.flatMap(w => [w & 0xff, w >> 8]),
    )
  }
  const [call, span] = OW_CGRAM_CODE as [{ addr: number; bytes: number[] }, { addr: number }]
  rom.writeAt(call.addr, [...call.bytes])
  rom.writeAt(span.addr, Buffer.alloc(CGRAM_SPAN, 0xea))
  for (const c of OW_L2_READER) {
    if ('bytes' in c)
      rom.writeAt(
        c.addr,
        c.bytes.map(b => (b === WILD ? 0 : b)),
      )
    else rom.writeAt(c.addr, Buffer.alloc(c.length, 0xea))
  }
  rom.writeAt(0x04dc72, [L2_LO & 0xff, (L2_LO >> 8) & 0xff])
  rom.writeAt(0x04dc79, [L2_LO >> 16])
  rom.writeAt(0x04dc8d, [L2_HI & 0xff, (L2_HI >> 8) & 0xff])
  plantL2(rom, l2Tilemap())
  plantGfx(rom)
  plantTitleMap(rom)
  plantPalettes(rom)
  plantStockPaletteCol1(rom)
  return rom
}
