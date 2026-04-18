/**
 * Render a side-by-side PNG comparing our TS port's expansion of level $002
 * against the Mesen-captured fixture. Diff cells are outlined in red.
 *
 * Output: test/levels/002/diff.png
 */
import { describe, it } from 'vitest'
import { existsSync, readFileSync, writeFileSync } from 'fs'
import { resolve } from 'path'
import { deflateSync } from 'zlib'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelObjects } from '../../../src/rom/LevelParser'
import { expandMap, TILE_EMPTY } from '../../../src/rom/ObjectExpander'
import { loadVram } from '../../../src/rom/GfxLoader'
import { loadAllMap16 } from '../../../src/rom/Map16'
import { renderMap16Tile } from '../../../src/rom/TileRenderer'
import { loadRomPalettes, buildLevelCgram } from '../../../src/rom/PaletteLoader'

const ROM_PATH     = resolve(__dirname, '../../roms/Super Mario World (USA).vanilla.sfc')
const FIXTURE_PATH = resolve(__dirname, '../../levels/002/map16.txt')
const OUT_PATH     = resolve(__dirname, '../../levels/002/diff.png')

const TILE_PX = 16
const ROW_LO  = 10
const ROW_HI  = 26

const CRC_TABLE = (() => {
  const t = new Uint32Array(256)
  for (let i = 0; i < 256; i++) {
    let c = i
    for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1)
    t[i] = c
  }
  return t
})()

function crc32(buf: Buffer): number {
  let c = 0xFFFFFFFF
  for (let i = 0; i < buf.length; i++) c = CRC_TABLE[(c ^ buf[i]) & 0xFF] ^ (c >>> 8)
  return (c ^ 0xFFFFFFFF) >>> 0
}

function pngChunk(type: string, data: Buffer): Buffer {
  const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0)
  const typeBuf = Buffer.from(type, 'ascii')
  const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])), 0)
  return Buffer.concat([len, typeBuf, data, crc])
}

function encodePng(w: number, h: number, rgba: Uint8Array): Buffer {
  const sig = Buffer.from([0x89, 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A])
  const ihdr = Buffer.alloc(13)
  ihdr.writeUInt32BE(w, 0)
  ihdr.writeUInt32BE(h, 4)
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0
  const scan = Buffer.alloc(h * (1 + w * 4))
  for (let y = 0; y < h; y++) {
    const off = y * (1 + w * 4)
    scan[off] = 0
    scan.set(rgba.subarray(y * w * 4, (y + 1) * w * 4), off + 1)
  }
  const idat = deflateSync(scan)
  return Buffer.concat([sig, pngChunk('IHDR', ihdr), pngChunk('IDAT', idat), pngChunk('IEND', Buffer.alloc(0))])
}

function blit(dst: Uint8Array, dstW: number, x0: number, y0: number,
              src: Uint8ClampedArray, srcW: number, srcH: number) {
  for (let y = 0; y < srcH; y++) {
    for (let x = 0; x < srcW; x++) {
      const si = (y * srcW + x) * 4
      const di = ((y0 + y) * dstW + (x0 + x)) * 4
      dst[di] = src[si]; dst[di + 1] = src[si + 1]
      dst[di + 2] = src[si + 2]; dst[di + 3] = src[si + 3]
    }
  }
}

function drawRect(dst: Uint8Array, dstW: number, x: number, y: number, w: number, h: number, r: number, g: number, b: number) {
  for (let i = 0; i < w; i++) {
    for (const yy of [y, y + h - 1]) {
      const di = (yy * dstW + (x + i)) * 4
      dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = 255
    }
  }
  for (let i = 0; i < h; i++) {
    for (const xx of [x, x + w - 1]) {
      const di = ((y + i) * dstW + xx) * 4
      dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = 255
    }
  }
}

function fillRect(dst: Uint8Array, dstW: number, x: number, y: number, w: number, h: number, r: number, g: number, b: number) {
  for (let i = 0; i < h; i++) {
    for (let j = 0; j < w; j++) {
      const di = ((y + i) * dstW + (x + j)) * 4
      dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = 255
    }
  }
}

function parseFixture(text: string) {
  let minCol = 0, maxCol = 0
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/min_col=(\d+)\s+max_col=(\d+)/)
    if (m) { minCol = Number(m[1]); maxCol = Number(m[2]); break }
  }
  const rows: Record<number, (number | null)[]> = {}
  for (const line of text.split(/\r?\n/)) {
    const m = line.match(/^r\s*(\d+):\s*(.*)/)
    if (!m) continue
    const row = Number(m[1])
    rows[row] = m[2].trim().split(/\s+/).map(t =>
      t === '???' ? null : t === '.' ? TILE_EMPTY : parseInt(t, 16),
    )
  }
  return { minCol, maxCol, rows }
}

describe.skipIf(!existsSync(ROM_PATH) || !existsSync(FIXTURE_PATH))('level $002 diff PNG', () => {
  it('renders side-by-side PNG with red boxes on mismatched tiles', () => {
    const rom = SmwRom.open(ROM_PATH)
    const rawL1 = rom.getLevelRawData(0x002)
    if (!rawL1) throw new Error('no level')
    const { header, objects } = parseLevelObjects(rawL1)

    const ourGrid = expandMap(objects, header.levelLength, rom.rom, header.objectTileset)
    const vram    = loadVram(rom.rom, header.objectTileset, header.spriteSet ?? 0)
    const allPal  = loadRomPalettes(rom.rom, header.bgPalette)
    const cgram   = buildLevelCgram(allPal, header.bgPalette, header.fgPalette, header.spriteSet ?? 0)
    const palette = { colors: cgram.colors }
    const tiles   = loadAllMap16(rom.rom, header.objectTileset)

    const fx = parseFixture(readFileSync(FIXTURE_PATH, 'utf8'))

    // Clamp to our grid's actual width to avoid drawing past level end.
    const gridCols = ourGrid[0]?.length ?? 0
    const colLo = fx.minCol
    const colHi = Math.min(fx.maxCol, gridCols - 1)
    const cols  = colHi - colLo + 1
    const rows  = ROW_HI - ROW_LO + 1

    const stripW = cols * TILE_PX
    const stripH = rows * TILE_PX
    const GAP = 12
    const LABEL_H = 18
    const imgW = stripW
    const imgH = LABEL_H + stripH + GAP + LABEL_H + stripH

    const img = new Uint8Array(imgW * imgH * 4)
    fillRect(img, imgW, 0, 0, imgW, imgH, 20, 20, 30)
    fillRect(img, imgW, 0, 0, imgW, LABEL_H, 60, 100, 60)
    fillRect(img, imgW, 0, LABEL_H + stripH + GAP, imgW, LABEL_H, 60, 60, 100)

    const emptySlot = new Uint8ClampedArray(TILE_PX * TILE_PX * 4)
    function getRender(id: number): Uint8ClampedArray {
      if (id === TILE_EMPTY || id < 0 || id >= tiles.length) return emptySlot
      return renderMap16Tile(tiles[id], vram, palette)
    }

    const topY = LABEL_H
    for (let r = 0; r < rows; r++) {
      const rowIdx = ROW_LO + r
      for (let c = 0; c < cols; c++) {
        const colIdx = colLo + c
        const id = ourGrid[rowIdx]?.[colIdx] ?? TILE_EMPTY
        blit(img, imgW, c * TILE_PX, topY + r * TILE_PX, getRender(id), TILE_PX, TILE_PX)
      }
    }
    const botY = LABEL_H + stripH + GAP + LABEL_H
    for (let r = 0; r < rows; r++) {
      const rowIdx = ROW_LO + r
      const rowArr = fx.rows[rowIdx] ?? []
      for (let c = 0; c < cols; c++) {
        const id = rowArr[c] ?? TILE_EMPTY
        blit(img, imgW, c * TILE_PX, botY + r * TILE_PX, getRender(id ?? TILE_EMPTY), TILE_PX, TILE_PX)
      }
    }

    let diffs = 0
    for (let r = 0; r < rows; r++) {
      const rowIdx = ROW_LO + r
      const rowArr = fx.rows[rowIdx] ?? []
      for (let c = 0; c < cols; c++) {
        const expected = rowArr[c]
        if (expected == null) continue
        const actual = ourGrid[rowIdx]?.[colLo + c] ?? TILE_EMPTY
        if (actual !== expected) {
          drawRect(img, imgW, c * TILE_PX, topY + r * TILE_PX, TILE_PX, TILE_PX, 255, 50, 50)
          drawRect(img, imgW, c * TILE_PX, botY + r * TILE_PX, TILE_PX, TILE_PX, 255, 50, 50)
          diffs++
        }
      }
    }

    writeFileSync(OUT_PATH, encodePng(imgW, imgH, img))
    console.log(`wrote ${OUT_PATH}  (${imgW}x${imgH}, ${diffs} diffs marked in red)`)
  })
})
