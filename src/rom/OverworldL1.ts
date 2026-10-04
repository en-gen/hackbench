/**
 * The overworld's L1 (foreground) grid, read through CODE_04DC09's own
 * operands. Trace: docs/rom/overworld.md.
 */
import { RomFile } from './RomFile'
import { BytePattern, WILD, findPattern } from './BytePattern'
import { decodeOwMap16, map16ByteOffset } from './OverworldLoader'
import { stockCodeMismatch, type StockCode } from './SubmapFlagGate'
import type { Map16Tile } from './Map16'
import { isLoRomRomAddress } from './addressing'
import { hex6 } from './hex'

export const OW_L1_COLS = 64
export const OW_L1_ROWS = 32
/** Each half is its own layout: half 0 the hub, half 1 areas 1-6, 32 of the 64 L1 columns each. */
export const OW_HALF_COLS = OW_L1_COLS / 2
/** Byte indices only (Map16TilesHigh is zeroed), 8 bytes per entry. */
const OW_L1_CHAR_BYTES = 256 * 8
const OW_L1_TILE_BYTES = 0x800

/**
 * CODE_04DC09 from the tileset load through the MVN, as three WILD-spanning
 * runs of at most 32 bytes. The WILDs are the operands read below.
 */
// prettier-ignore
export const OW_L1_READER: readonly StockCode[] = [
  { addr: 0x00a126, bytes: [0x22, 0x09, 0xdc, 0x04], bankAt: 3,
    what: 'JSL CODE_04DC09', cite: 'bank_00.asm:4321' },
  // The per-area index: SEP #$30 : LDA PlayerTurnOW : LSR : LSR : TAX : LDA OWPlayerSubmap,X : TAX.
  { addr: 0x04dc09,
    bytes: [0xe2, 0x30, 0xad, 0xd6, 0x0d, 0x4a, 0x4a, 0xaa, 0xbd, 0x11, 0x1f, 0xaa],
    what: 'SEP #$30 through TAX, the OWPlayerSubmap index', cite: 'bank_04.asm:5638-5644' },
  { addr: 0x04dc15,
    bytes: [0xbf, WILD, WILD, WILD, 0x8d, 0x31, 0x19, 0xa9, WILD, 0x8d, 0x2b, 0x19,
      0xa9, 0x07, 0x8d, 0x25, 0x19, 0xa9, 0x03, 0x85, 0x5b, 0xc2, 0x10],
    what: 'LDA.L DATA_04DC02,X through REP #$10', cite: 'bank_04.asm:5645-5653' },
  { addr: 0x04dc2c,
    bytes: [0xa2, 0x00, 0x00, 0x8a, 0x20, 0x70, 0xd7, 0xe0, 0xb0, 0x01, 0xd0, 0xf8,
      0xc2, 0x30, 0xa9, WILD, WILD, 0x85, 0x00, 0xa2, 0x00, 0x00, 0xa5, 0x00,
      0x9d, 0xbe, 0x0f, 0xa5, 0x00, 0x18, 0x69, 0x08],
    what: 'JSR CODE_04D770 through ADC #$0008', cite: 'bank_04.asm:5654-5667' },
  { addr: 0x04dc4c,
    bytes: [0x00, 0x85, 0x00, 0xe8, 0xe8, 0xe0, 0x00, 0x04, 0xd0, 0xec, 0x8b, 0xa9,
      0xff, 0x07, 0xa2, WILD, WILD, 0xa0, 0x00, 0xc8, 0x54, 0x7e, WILD],
    what: 'CPX #$0400 through MVN', cite: 'bank_04.asm:5667-5677' },
]

/** bank_05.asm:1196-1201: the Map16Pointers bank, chosen by ObjectTileset. */
// prettier-ignore
const CHAR_BANK_SELECT: BytePattern =
  [0xa0, WILD, 0xad, 0x31, 0x19, 0xc9, WILD, 0x30, 0x02, 0xa0, WILD, 0x84, 0x0c]

export interface OwL1Source {
  tileData: Uint8Array
  charData: Uint8Array
  objectTileset: number
  spriteTileset: number
}

export type OwL1Read = ({ ok: true } & OwL1Source) | { ok: false; reason: string }

const refuse = (reason: string): OwL1Read => ({ ok: false, reason })

/** The bank the L1 upload reads Map16Pointers in, for `objectTileset`, or why not. */
function charBank(rom: RomFile, objectTileset: number): number | string {
  const hits = findPattern(rom, CHAR_BANK_SELECT, 8)
  if (hits.length === 0) return 'the Map16 bank select (bank_05.asm:1196-1201) is not present'
  const banks = new Set(
    hits.map(at => {
      const b = rom.readAtFileOffset(at, CHAR_BANK_SELECT.length)!
      // CMP #thr : BMI takes the first LDY when (tileset - thr) is negative.
      return ((objectTileset - b[6]!) & 0x80) !== 0 ? b[1]! : b[10]!
    }),
  )
  if (banks.size > 1) return `the ${hits.length} Map16 bank selects disagree on the bank`
  return [...banks][0]!
}

/**
 * The L1 tile data, char data and tilesets `area` loads, or why they cannot be read:
 * DATA_04DC02[OWPlayerSubmap] (bank_04.asm:5643-5646), no fallback when the byte is not in the ROM.
 * No readable bound on the table's length exists (the index is the area byte, and the table's
 * end is not an operand), so an area past it reads whatever follows: a named fragility point,
 * kept in check by the area derivation marking areas past the camera table invalid.
 */
export function readOverworldL1(rom: RomFile, area = 0): OwL1Read {
  if (rom.mapMode !== 'lorom') return refuse('The overworld L1 reader reads LoROM only.')
  const mismatch = stockCodeMismatch(rom, OW_L1_READER)
  if (mismatch) return refuse(`The overworld L1 reader is not stock: ${mismatch}`)
  const tilesetTable = rom.readAt(0x04dc16, 3)!
  const tilesetAddr = tilesetTable[0]! | (tilesetTable[1]! << 8) | (tilesetTable[2]! << 16)
  const entry = tilesetAddr + area
  const objectTileset = isLoRomRomAddress(entry) ? rom.readByte(entry) : null
  if (objectTileset === null) {
    return refuse(`Area ${area}'s object tileset at $${hex6(entry)} is not in the ROM.`)
  }
  const spriteTileset = rom.readByte(0x04dc1d)!

  const bank = charBank(rom, objectTileset)
  if (typeof bank === 'string') return refuse(`Overworld L1 char data: ${bank}.`)
  const charAddr = (bank << 16) | rom.readWord(0x04dc3b)!
  const tileAddr = (rom.readByte(0x04dc62)! << 16) | rom.readWord(0x04dc5b)!
  const notRom = !isLoRomRomAddress(charAddr)
    ? 'char'
    : !isLoRomRomAddress(tileAddr)
      ? 'tile'
      : null
  if (notRom) return refuse(`The overworld L1 ${notRom} data is not read from the ROM.`)

  const tileData = rom.readAt(tileAddr, OW_L1_TILE_BYTES)
  const charData = rom.readAt(charAddr, OW_L1_CHAR_BYTES)
  if (!tileData || !charData) return refuse('The overworld L1 data runs past the end of the ROM.')
  return {
    ok: true,
    tileData: Uint8Array.from(tileData),
    charData: Uint8Array.from(charData),
    objectTileset,
    spriteTileset,
  }
}

/** The whole grid, row-major, 64 wide: columns 0-31 are half 0, 32-63 half 1 (drawn separately). */
export function composeOverworldL1Grid(tileData: Uint8Array, charData: Uint8Array): Map16Tile[] {
  const grid: Map16Tile[] = []
  for (let row = 0; row < OW_L1_ROWS; row++) {
    for (let col = 0; col < OW_L1_COLS; col++) {
      const id = tileData[map16ByteOffset((col >> 5) as 0 | 1, row, col & 31)] ?? 0
      // OwMap16's subtiles carry exactly SubTile's fields.
      grid.push({ id, ...decodeOwMap16(charData, id) })
    }
  }
  return grid
}
