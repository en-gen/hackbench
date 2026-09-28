/**
 * The overworld's L2 (background) tilemap, read through CODE_04DC6A's own
 * operands, and each layer drawn to pixels for OverworldComposite.
 * Trace: docs/rom/overworld.md.
 */
import { RomFile } from './RomFile'
import { WILD } from './BytePattern'
import { decompressOwRleStream, OW_L2_TILEMAP_BYTES, tilemapByteOffset } from './OverworldLoader'
import { stockCodeMismatch, type StockCode, type StockSpan } from './SubmapFlagGate'
import { decodeSubTileWord, type Map16Tile, type SubTile } from './Map16'
import type { VramState } from './GfxLoader'
import type { RgbaColor } from './GraphicsDecoder'
import { renderSubTile } from './TileRenderer'
import { OW_CANVAS_H, OW_CANVAS_W, OW_L1_COLS } from './OverworldL1'
import type { OwLayerPixels } from './render/OverworldComposite'
import { isLoRomRomAddress } from './addressing'
import { hex6 } from './hex'

/** Opcodes and constant operands; the stream operands are WILD and read below. */
// prettier-ignore
export const OW_L2_READER: readonly (StockCode | StockSpan)[] = [
  { addr: 0x009e13, bytes: [0x22, 0xad, 0xda, 0x04], bankAt: 3,
    what: 'JSL DecompressOverworldL2', cite: 'bank_00.asm:3744' },
  { addr: 0x00a101, bytes: [0x22, 0xad, 0xda, 0x04], bankAt: 3,
    what: 'JSL DecompressOverworldL2', cite: 'bank_00.asm:4301' },
  // Layout 1 belongs to half 1: on a submap the L2 DMA source high byte is $60.
  { addr: 0x00a54b, bytes: [0xbd, 0x11, 0x1f, 0xf0, 0x05, 0xa9, 0x60, 0x8d, 0x13, 0x43],
    what: 'LDA OWPlayerSubmap,X : BEQ : LDA #$60 : STA HW_DMAADDR+$11', cite: 'bank_00.asm:4809-4812' },
  { addr: 0x04d760, bytes: [0xbd, 0x11, 0x1f, 0xf0, 0x05, 0xa9, 0x60, 0x8d, 0x13, 0x43],
    what: 'LDA OWPlayerSubmap,X : BEQ : LDA #$60 : STA HW_DMAADDR+$11', cite: 'bank_04.asm:5219-5222' },
  { addr: 0x04daad, bytes: [0x08, 0x20, 0x6a, 0xdc, 0x28, 0x6b],
    what: 'DecompressOverworldL2', cite: 'bank_04.asm:5440-5444' },
  { addr: 0x04dc6a,
    bytes: [0xe2, 0x30, 0x20, 0x40, 0xdd, 0xc2, 0x20, 0xa9, WILD, WILD, 0x85, 0x00,
      0xe2, 0x30, 0xa9, WILD, 0x85, 0x02],
    what: 'LDA #OWTileNumbers : LDA #bank', cite: 'bank_04.asm:5684-5691' },
  { addr: 0x04dc7c,
    bytes: [0xc2, 0x10, 0xa0, 0x00, 0x40, 0x84, 0x0e, 0xa0, 0x00, 0x00, 0xbb,
      0x20, 0xba, 0xda, 0xc2, 0x20, 0xa9, WILD, WILD, 0x85, 0x00],
    what: 'LDY #$4000 : JSR CODE_04DABA : LDA #OWTilemap', cite: 'bank_04.asm:5692-5700' },
  { addr: 0x04dc91, bytes: [0xe2, 0x20, 0xa2, 0x01, 0x00, 0xa0, 0x00, 0x00, 0x20, 0xba, 0xda],
    what: 'LDX #1 : JSR CODE_04DABA', cite: 'bank_04.asm:5701-5704' },
  { addr: 0x04daba, length: 0x35,
    fingerprints: ['65bdcd64cb9d4df7d3fdba5f09671def37e329df63c93556e1fb20bc1a19e8aa'],
    what: 'CODE_04DABA, the RLE decoder', cite: 'bank_04.asm:5452-5483' },
]

export type OwL2Read = { ok: true; tilemap: Uint8Array } | { ok: false; reason: string }

/** One stream, decoded into every other byte of `dest`, or why it ran out. */
function decodeStream(rom: RomFile, addr: number, dest: Uint8Array, start: number): string | null {
  // [_0],Y carries into the next bank, which in LoROM is not ROM: stop at the bank end.
  const src = isLoRomRomAddress(addr) ? rom.readUpTo(addr, 0x10000 - (addr & 0xffff)) : null
  if (!src) return `the stream at $${hex6(addr)} is not in the ROM`
  const written = decompressOwRleStream(src, 0, dest, start, 2)
  return written >= dest.length ? null : `the stream at $${hex6(addr)} ends before $4000 bytes`
}

/** The $4000-byte L2 tilemap, two 64x64 layouts of words, before any event is applied. */
export function readOverworldL2(rom: RomFile, spanFingerprints?: readonly string[]): OwL2Read {
  if (rom.mapMode !== 'lorom') return { ok: false, reason: 'the L2 reader reads LoROM only' }
  const code = stockCodeMismatch(rom, OW_L2_READER, spanFingerprints)
  if (code) return { ok: false, reason: `the L2 decompressor is not stock: ${code}` }
  const bank = rom.readByte(0x04dc79)! << 16
  const tilemap = new Uint8Array(OW_L2_TILEMAP_BYTES)
  const why =
    decodeStream(rom, bank | rom.readWord(0x04dc72)!, tilemap, 0) ??
    decodeStream(rom, bank | rom.readWord(0x04dc8d)!, tilemap, 1)
  return why ? { ok: false, reason: why } : { ok: true, tilemap }
}

/**
 * One layer's pixels on a clear canvas, plus each 8x8 cell's priority bit.
 * Subtiles within a layer never overlap, so draw order does not matter here;
 * OverworldComposite interleaves the two layers by priority.
 */
function drawLayer(
  cells: (put: (sub: SubTile, x: number, y: number) => void) => void,
  vram: VramState,
  palette: { colors: RgbaColor[] },
): OwLayerPixels {
  const stride = OW_CANVAS_W * 4
  const rgba = new Uint8ClampedArray(stride * OW_CANVAS_H)
  const cellsW = OW_CANVAS_W >> 3
  const prio = new Uint8Array(cellsW * (OW_CANVAS_H >> 3))
  cells((sub, x, y) => {
    renderSubTile(sub, vram, palette, rgba, y * stride + x * 4, stride)
    prio[(y >> 3) * cellsW + (x >> 3)] = sub.priority ? 1 : 0
  })
  return { rgba, prio }
}

/** L1 and, when readable, L2, half 0 left of half 1 (a view choice). */
export function drawOverworldLayers(
  l1: Map16Tile[],
  l2: Uint8Array | null,
  vram: VramState,
  palette: { colors: RgbaColor[] },
): { l1: OwLayerPixels; l2: OwLayerPixels | null } {
  return {
    l1: drawLayer(
      put =>
        l1.forEach((t, i) => {
          const x = (i % OW_L1_COLS) * 16
          const y = Math.floor(i / OW_L1_COLS) * 16
          put(t.tl, x, y)
          put(t.tr, x + 8, y)
          put(t.bl, x, y + 8)
          put(t.br, x + 8, y + 8)
        }),
      vram,
      palette,
    ),
    l2:
      l2 &&
      drawLayer(
        put => {
          for (let y = 0; y < 64; y++)
            for (let x = 0; x < 128; x++) {
              const at = tilemapByteOffset((x >> 6) as 0 | 1, y, x & 63)
              put(decodeSubTileWord(l2[at]! | (l2[at + 1]! << 8)), x * 8, y * 8)
            }
        },
        vram,
        palette,
      ),
  }
}
