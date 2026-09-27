/**
 * The overworld's L1 (foreground) grid, read through CODE_04DC09's own
 * operands. Trace: docs/rom/overworld-l1.md.
 */
import { RomFile } from './RomFile'
import { BytePattern, WILD, findPattern } from './BytePattern'
import { decodeOwMap16, map16ByteOffset } from './OverworldLoader'
import { stockCodeMismatch, type StockCode } from './SubmapFlagGate'
import type { Map16Tile } from './Map16'
import { hex6 } from './hex'

export const OW_L1_COLS = 64
export const OW_L1_ROWS = 32
/** Byte indices only (Map16TilesHigh is zeroed), 8 bytes per entry. */
const OW_L1_CHAR_BYTES = 256 * 8
const OW_L1_TILE_BYTES = 0x800

const pin = (addr: number, bytes: number[], what: string, cite: string): StockCode => ({
  addr,
  bytes,
  what,
  cite,
})

/** Opcodes and the constant operands this reading depends on. */
// prettier-ignore
export const OW_L1_READER: readonly StockCode[] = [
  { ...pin(0x00a126, [0x22, 0x09, 0xdc, 0x04], 'JSL CODE_04DC09', 'bank_00.asm:4321'), bankAt: 3 },
  pin(0x04dc15, [0xbf], 'LDA.L DATA_04DC02,X', 'bank_04.asm:5645'),
  pin(0x04dc19, [0x8d, 0x31, 0x19, 0xa9], 'STA ObjectTileset : LDA #imm', 'bank_04.asm:5646-5647'),
  pin(0x04dc2c, [0xa2, 0x00, 0x00, 0x8a, 0x20, 0x70, 0xd7, 0xe0, 0xb0, 0x01],
    'LDX #0 : TXA : JSR CODE_04D770 : CPX #$01B0', 'bank_04.asm:5654-5657'),
  pin(0x04dc3a, [0xa9], 'LDA.W #OWL1CharData', 'bank_04.asm:5660'),
  pin(0x04dc44, [0x9d, 0xbe, 0x0f], 'STA Map16Pointers,X', 'bank_04.asm:5664'),
  pin(0x04dc4a, [0x69, 0x08, 0x00], 'ADC.W #$0008', 'bank_04.asm:5667'),
  pin(0x04dc51, [0xe0, 0x00, 0x04], 'CPX.W #$0400', 'bank_04.asm:5671'),
  pin(0x04dc57, [0xa9, 0xff, 0x07, 0xa2], 'LDA #$07FF : LDX', 'bank_04.asm:5674-5675'),
  pin(0x04dc5d, [0xa0, 0x00, 0xc8, 0x54, 0x7e], 'LDY #Map16TilesLow : MVN $7E', 'bank_04.asm:5676-5677'),
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

/** A LoROM address the cartridge maps, rather than RAM a static read cannot see. */
const isRomAddress = (snes: number): boolean => snes >> 16 < 0x7e && (snes & 0xffff) >= 0x8000

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

/** The L1 tile data, char data and tilesets area 0 loads, or why they cannot be read. */
export function readOverworldL1(rom: RomFile): OwL1Read {
  const mismatch = stockCodeMismatch(rom, OW_L1_READER)
  if (mismatch) return refuse(`The overworld L1 reader is not stock: ${mismatch}`)
  const tilesetTable = rom.readAt(0x04dc16, 3)!
  const tilesetAddr = tilesetTable[0]! | (tilesetTable[1]! << 8) | (tilesetTable[2]! << 16)
  const objectTileset = isRomAddress(tilesetAddr) ? rom.readByte(tilesetAddr) : null
  if (objectTileset === null) {
    return refuse(`The object tileset table at $${hex6(tilesetAddr)} is not in the ROM.`)
  }
  const spriteTileset = rom.readByte(0x04dc1d)!

  const bank = charBank(rom, objectTileset)
  if (typeof bank === 'string') return refuse(`Overworld L1 char data: ${bank}.`)
  const charAddr = (bank << 16) | rom.readWord(0x04dc3b)!
  const tileAddr = (rom.readByte(0x04dc62)! << 16) | rom.readWord(0x04dc5b)!
  const notRom = !isRomAddress(charAddr) ? 'char' : !isRomAddress(tileAddr) ? 'tile' : null
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

/** The whole grid, row-major, 64 wide: half 0 on the left, half 1 on the right (a view choice). */
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
