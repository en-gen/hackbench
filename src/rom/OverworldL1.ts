/**
 * The overworld's L1 (foreground) as one map: the whole `Map16TilesLow` grid,
 * 64x32 Map16 tiles, two 32x32 halves side by side (map16ByteOffset).
 *
 * Every address is read from the code that uses it, never from OW_ADDR:
 *
 *   CODE_04DC09 (bank_04.asm:5637-5681) copies $800 bytes of tile data into
 *   Map16TilesLow with `LDA #$07FF : LDX #src : LDY #dest : MVN $7E,srcBank`,
 *   and fills Map16Pointers with `#OWL1CharData + 8*i`. It first zeroes
 *   Map16TilesHigh through CODE_04D770 (:5654-5658, :5227-5261), so a tile
 *   index is one byte and only 256 char entries are reachable.
 *
 *   Map16Pointers holds 16-bit addresses. The bank they are read in comes
 *   from the L1 upload routines' `LDY #$0D : LDA ObjectTileset : CMP #$10 :
 *   BMI : LDY #$05 : STY _C` (bank_05.asm:1196-1201, and three copies at
 *   :1314, :1440, :1568, one per scroll direction). All four run, so all
 *   four must agree.
 *
 * The overworld load reaches CODE_04DC09 through `JSL CODE_04DC09` at
 * bank_00.asm:4321; that call is pinned too, since a hack that diverts it
 * leaves the routine intact and unreached.
 */
import { RomFile } from './RomFile'
import { BytePattern, WILD, findPattern } from './BytePattern'
import { decodeOwMap16, map16ByteOffset } from './OverworldLoader'
import type { Map16Tile } from './Map16'
import type { VramState } from './GfxLoader'
import type { RgbaColor } from './GraphicsDecoder'
import { renderMap16Tile } from './TileRenderer'
import { hex6 } from './hex'

export const OW_L1_COLS = 64
export const OW_L1_ROWS = 32
const MAP16_PX = 16
/** Byte indices only (Map16TilesHigh is zeroed), 8 bytes per entry. */
const OW_L1_CHAR_BYTES = 256 * 8
const OW_L1_TILE_BYTES = 0x800

export interface Pin {
  addr: number
  bytes: readonly number[]
  cite: string
}

/** Opcodes and the constant operands this reading depends on. */
// prettier-ignore
export const OW_L1_READER_PINS: readonly Pin[] = [
  { addr: 0x00a126, bytes: [0x22, 0x09, 0xdc, 0x04], cite: 'JSL CODE_04DC09 (bank_00.asm:4321)' },
  { addr: 0x04dc15, bytes: [0xbf], cite: 'LDA.L DATA_04DC02,X (bank_04.asm:5645)' },
  { addr: 0x04dc1c, bytes: [0xa9], cite: 'LDA #SpriteTileset (bank_04.asm:5647)' },
  { addr: 0x04dc2c, bytes: [0xa2, 0x00, 0x00, 0x8a, 0x20], cite: 'LDX #0 : TXA (bank_04.asm:5654)' },
  { addr: 0x04dc3a, bytes: [0xa9], cite: 'LDA.W #OWL1CharData (bank_04.asm:5660)' },
  { addr: 0x04dc4a, bytes: [0x69, 0x08, 0x00], cite: 'ADC.W #$0008 (bank_04.asm:5667)' },
  { addr: 0x04dc57, bytes: [0xa9, 0xff, 0x07, 0xa2], cite: 'LDA #$07FF : LDX (bank_04.asm:5674)' },
  { addr: 0x04dc5d, bytes: [0xa0, 0x00, 0xc8, 0x54, 0x7e], cite: 'LDY : MVN $7E (bank_04.asm:5676)' },
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

/** The L1 tile data, char data and tilesets window 0 loads, or why they cannot be read. */
export function readOverworldL1(rom: RomFile): OwL1Read {
  for (const pin of OW_L1_READER_PINS) {
    const got = rom.readAt(pin.addr, pin.bytes.length)
    if (!got || pin.bytes.some((b, i) => got[i] !== b)) {
      return refuse(`The overworld L1 reader is not stock at $${hex6(pin.addr)}: ${pin.cite}.`)
    }
  }
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

/** The whole grid, row-major, 64 wide: left half is buffer half 0, right half is 1. */
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

/** RGBA for the grid, (64*16) x (32*16), through the shared Map16 renderer. */
export function renderOverworldL1(
  grid: Map16Tile[],
  vram: VramState,
  palette: { colors: RgbaColor[] },
): Uint8ClampedArray {
  const width = OW_L1_COLS * MAP16_PX
  const out = new Uint8ClampedArray(width * OW_L1_ROWS * MAP16_PX * 4)
  const cache = new Map<number, Uint8ClampedArray>()
  grid.forEach((tile, i) => {
    let px = cache.get(tile.id)
    if (!px) cache.set(tile.id, (px = renderMap16Tile(tile, vram, palette)))
    const x0 = (i % OW_L1_COLS) * MAP16_PX
    const y0 = Math.floor(i / OW_L1_COLS) * MAP16_PX
    for (let y = 0; y < MAP16_PX; y++) {
      out.set(px.subarray(y * MAP16_PX * 4, (y + 1) * MAP16_PX * 4), ((y0 + y) * width + x0) * 4)
    }
  })
  return out
}
