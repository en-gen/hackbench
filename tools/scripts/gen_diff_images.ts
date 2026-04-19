/**
 * Regenerate the side-by-side diff PNG for every sublevel that has a Mesen
 * fixture at OneDrive/hackbench-fixtures/maps/<hhh>/map16.txt. Output lands
 * next to the fixture as diff.png.
 *
 * Top strip: our TS port's expansion. Bottom strip: fixture. Red rectangles
 * mark cells where we disagree.
 *
 * Run:
 *   npx tsx tools/scripts/gen_diff_images.ts
 */
import { readdirSync, readFileSync, writeFileSync, existsSync, statSync } from 'fs'
import { resolve } from 'path'
import { deflateSync } from 'zlib'
import { SmwRom } from '../../src/rom/SmwRom'
import { parseLevelObjects } from '../../src/rom/LevelParser'
import { expandMap, TILE_EMPTY } from '../../src/rom/ObjectExpander'
import { loadVram } from '../../src/rom/GfxLoader'
import { loadAllMap16 } from '../../src/rom/Map16'
import { renderMap16Tile } from '../../src/rom/TileRenderer'
import { loadRomPalettes, buildLevelCgram } from '../../src/rom/PaletteLoader'
import { getLevelNameByIndex } from '../../src/rom/SmwLevelNames'

const ROM_PATH  = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`
const MAPS_DIR  = `${process.env.USERPROFILE ?? process.env.HOME}/OneDrive/hackbench-fixtures/maps`
const TILE_PX   = 16

// ── Minimal PNG encoder (no deps) ───────────────────────────────────────────
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
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4)
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

// ── Canvas helpers ──────────────────────────────────────────────────────────
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

// ── Minimal 5x7 bitmap font (just the glyphs we need for the labels) ────────
const FONT: Record<string, number[]> = {
  // Each array = 7 rows, each number = 5-bit mask (bit 4 = leftmost pixel).
  'A': [0x0E, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  'B': [0x1E, 0x11, 0x11, 0x1E, 0x11, 0x11, 0x1E],
  'C': [0x0F, 0x10, 0x10, 0x10, 0x10, 0x10, 0x0F],
  'D': [0x1E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x1E],
  'E': [0x1F, 0x10, 0x10, 0x1C, 0x10, 0x10, 0x1F],
  'F': [0x1F, 0x10, 0x10, 0x1E, 0x10, 0x10, 0x10],
  'G': [0x0F, 0x10, 0x10, 0x13, 0x11, 0x11, 0x0F],
  'H': [0x11, 0x11, 0x11, 0x1F, 0x11, 0x11, 0x11],
  'I': [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x1F],
  'J': [0x07, 0x02, 0x02, 0x02, 0x02, 0x12, 0x0C],
  'K': [0x11, 0x12, 0x14, 0x18, 0x14, 0x12, 0x11],
  'L': [0x10, 0x10, 0x10, 0x10, 0x10, 0x10, 0x1F],
  'M': [0x11, 0x1B, 0x15, 0x15, 0x11, 0x11, 0x11],
  'N': [0x11, 0x19, 0x15, 0x13, 0x11, 0x11, 0x11],
  'O': [0x0E, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  'P': [0x1E, 0x11, 0x11, 0x1E, 0x10, 0x10, 0x10],
  'Q': [0x0E, 0x11, 0x11, 0x11, 0x15, 0x12, 0x0D],
  'R': [0x1E, 0x11, 0x11, 0x1E, 0x14, 0x12, 0x11],
  'S': [0x0F, 0x10, 0x10, 0x0E, 0x01, 0x01, 0x1E],
  'T': [0x1F, 0x04, 0x04, 0x04, 0x04, 0x04, 0x04],
  'U': [0x11, 0x11, 0x11, 0x11, 0x11, 0x11, 0x0E],
  'V': [0x11, 0x11, 0x11, 0x11, 0x11, 0x0A, 0x04],
  'W': [0x11, 0x11, 0x11, 0x15, 0x15, 0x1B, 0x11],
  'X': [0x11, 0x11, 0x0A, 0x04, 0x0A, 0x11, 0x11],
  'Y': [0x11, 0x11, 0x0A, 0x04, 0x04, 0x04, 0x04],
  'Z': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x10, 0x1F],
  '0': [0x0E, 0x11, 0x13, 0x15, 0x19, 0x11, 0x0E],
  '1': [0x04, 0x0C, 0x04, 0x04, 0x04, 0x04, 0x0E],
  '2': [0x0E, 0x11, 0x01, 0x02, 0x04, 0x08, 0x1F],
  '3': [0x1E, 0x01, 0x01, 0x0E, 0x01, 0x01, 0x1E],
  '4': [0x02, 0x06, 0x0A, 0x12, 0x1F, 0x02, 0x02],
  '5': [0x1F, 0x10, 0x1E, 0x01, 0x01, 0x11, 0x0E],
  '6': [0x06, 0x08, 0x10, 0x1E, 0x11, 0x11, 0x0E],
  '7': [0x1F, 0x01, 0x02, 0x04, 0x08, 0x08, 0x08],
  '8': [0x0E, 0x11, 0x11, 0x0E, 0x11, 0x11, 0x0E],
  '9': [0x0E, 0x11, 0x11, 0x0F, 0x01, 0x02, 0x0C],
  '$': [0x04, 0x0F, 0x14, 0x0E, 0x05, 0x1E, 0x04],
  '#': [0x0A, 0x1F, 0x0A, 0x1F, 0x0A, 0, 0],
  "'": [0x04, 0x04, 0, 0, 0, 0, 0],
  ' ': [0, 0, 0, 0, 0, 0, 0],
  ':': [0, 0x04, 0, 0, 0, 0x04, 0],
  '-': [0, 0, 0, 0x0E, 0, 0, 0],
  '(': [0x02, 0x04, 0x08, 0x08, 0x08, 0x04, 0x02],
  ')': [0x08, 0x04, 0x02, 0x02, 0x02, 0x04, 0x08],
}

function drawText(dst: Uint8Array, dstW: number, x: number, y: number, text: string, r: number, g: number, b: number, scale = 2) {
  const upper = text.toUpperCase()
  let cx = x
  for (const ch of upper) {
    const glyph = FONT[ch] ?? FONT[' ']
    for (let gy = 0; gy < 7; gy++) {
      const row = glyph[gy]
      for (let gx = 0; gx < 5; gx++) {
        if ((row >> (4 - gx)) & 1) {
          // Draw a scale×scale block for this pixel.
          for (let sy = 0; sy < scale; sy++) {
            for (let sx = 0; sx < scale; sx++) {
              const px = cx + gx * scale + sx
              const py = y + gy * scale + sy
              const di = (py * dstW + px) * 4
              dst[di] = r; dst[di + 1] = g; dst[di + 2] = b; dst[di + 3] = 255
            }
          }
        }
      }
    }
    cx += 6 * scale   // 5 pixel glyph + 1 px gap
  }
}

// ── Fixture parse ───────────────────────────────────────────────────────────
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

// ── Main loop ───────────────────────────────────────────────────────────────
const rom = SmwRom.open(ROM_PATH)

// Optional --level <hex> filter to iterate faster on one level.
const args = process.argv.slice(2)
const levelArgIdx = args.indexOf('--level')
const levelFilter = levelArgIdx >= 0 ? args[levelArgIdx + 1]?.toLowerCase() : null

const folders = readdirSync(MAPS_DIR)
  .filter(name => /^[0-9a-fA-F]{3}$/.test(name))
  .filter(name => existsSync(`${MAPS_DIR}/${name}/map16.txt`))
  .filter(name => !levelFilter || name.toLowerCase() === levelFilter)
  .sort()

console.log(`found ${folders.length} fixtures to diff\n`)

const results: Array<{ lvl: string; diffs: number; observed: number; pct: string; status: string }> = []

for (const name of folders) {
  const levelNum = parseInt(name, 16)
  const fixturePath = `${MAPS_DIR}/${name}/map16.txt`
  const outPath     = `${MAPS_DIR}/${name}/diff.png`

  const rawL1 = rom.getLevelRawData(levelNum)
  if (!rawL1) { results.push({ lvl: name, diffs: -1, observed: 0, pct: '—', status: 'no L1 data' }); continue }

  const { header, objects } = parseLevelObjects(rawL1)
  const ourGrid = expandMap(objects, header.levelLength, rom.rom, header.objectTileset)

  let vram, cgram, tiles
  try {
    vram    = loadVram(rom.rom, header.objectTileset, header.spriteSet ?? 0)
    const allPal = loadRomPalettes(rom.rom, header.bgPalette)
    const cg  = buildLevelCgram(allPal, header.bgPalette, header.fgPalette, header.spriteSet ?? 0)
    cgram   = { colors: cg.colors }
    tiles   = loadAllMap16(rom.rom, header.objectTileset)
  } catch (e) {
    results.push({ lvl: name, diffs: -1, observed: 0, pct: '—', status: `render setup failed: ${(e as Error).message}` })
    continue
  }

  const fx = parseFixture(readFileSync(fixturePath, 'utf8'))

  const colLo = fx.minCol
  const colHi = fx.maxCol
  const cols  = colHi - colLo + 1
  // Trim to populated rows so the image isn't 95% sky.
  let rowLo = 26, rowHi = 0
  for (let r = 0; r <= 26; r++) {
    const arr = fx.rows[r] ?? []
    const ourArr = ourGrid[r] ?? []
    let hasContent = false
    for (let c = 0; c < cols; c++) {
      const fxT = arr[c]
      const ourT = ourArr[colLo + c] ?? TILE_EMPTY
      if ((fxT != null && fxT !== TILE_EMPTY) || ourT !== TILE_EMPTY) { hasContent = true; break }
    }
    if (hasContent) { if (r < rowLo) rowLo = r; if (r > rowHi) rowHi = r }
  }
  if (rowHi < rowLo) { rowLo = 0; rowHi = 26 }
  // Pad 1 row so nearby empties are visible.
  rowLo = Math.max(0, rowLo - 1)
  rowHi = Math.min(26, rowHi + 1)
  const rows = rowHi - rowLo + 1

  const stripW = cols * TILE_PX
  const stripH = rows * TILE_PX
  const GAP = 12
  const LABEL_H = 22   // 5x7 glyph @ scale 2 = 14 px + 4 px padding top/bot
  const imgW = stripW
  const imgH = LABEL_H + stripH + GAP + LABEL_H + stripH

  const img = new Uint8Array(imgW * imgH * 4)
  fillRect(img, imgW, 0, 0, imgW, imgH, 20, 20, 30)
  fillRect(img, imgW, 0, 0, imgW, LABEL_H, 60, 100, 60)                      // ours (TS port) = green
  fillRect(img, imgW, 0, LABEL_H + stripH + GAP, imgW, LABEL_H, 60, 60, 100)  // fixture (Mesen) = blue
  const levelName = getLevelNameByIndex(rom.rom, levelNum)
  const nameSuffix = levelName ? ` - ${levelName}` : ''
  drawText(img, imgW, 6, 4, `OURS (TS PORT) - $${name.toUpperCase()}${nameSuffix}`, 255, 255, 255, 2)
  drawText(img, imgW, 6, LABEL_H + stripH + GAP + 4, `FIXTURE (MESEN) - $${name.toUpperCase()}${nameSuffix}`, 255, 255, 255, 2)

  const emptySlot = new Uint8ClampedArray(TILE_PX * TILE_PX * 4)
  const getRender = (id: number): Uint8ClampedArray => {
    if (id === TILE_EMPTY || id < 0 || id >= tiles!.length) return emptySlot
    return renderMap16Tile(tiles![id], vram!, cgram!)
  }

  const topY = LABEL_H
  for (let r = 0; r < rows; r++) {
    const rowIdx = rowLo + r
    for (let c = 0; c < cols; c++) {
      const id = ourGrid[rowIdx]?.[colLo + c] ?? TILE_EMPTY
      blit(img, imgW, c * TILE_PX, topY + r * TILE_PX, getRender(id), TILE_PX, TILE_PX)
    }
  }
  const botY = LABEL_H + stripH + GAP + LABEL_H
  for (let r = 0; r < rows; r++) {
    const rowIdx = rowLo + r
    const rowArr = fx.rows[rowIdx] ?? []
    for (let c = 0; c < cols; c++) {
      const id = rowArr[c] ?? TILE_EMPTY
      blit(img, imgW, c * TILE_PX, botY + r * TILE_PX, getRender(id), TILE_PX, TILE_PX)
    }
  }

  let diffs = 0, observed = 0
  for (let r = 0; r < rows; r++) {
    const rowIdx = rowLo + r
    const rowArr = fx.rows[rowIdx] ?? []
    for (let c = 0; c < cols; c++) {
      const expected = rowArr[c]
      if (expected == null) continue
      observed++
      const actual = ourGrid[rowIdx]?.[colLo + c] ?? TILE_EMPTY
      if (actual !== expected) {
        drawRect(img, imgW, c * TILE_PX, topY + r * TILE_PX, TILE_PX, TILE_PX, 255, 50, 50)
        drawRect(img, imgW, c * TILE_PX, botY + r * TILE_PX, TILE_PX, TILE_PX, 255, 50, 50)
        diffs++
      }
    }
  }

  writeFileSync(outPath, encodePng(imgW, imgH, img))
  const pct = observed ? ((100 * (observed - diffs)) / observed).toFixed(2) + '%' : '—'
  results.push({ lvl: name, diffs, observed, pct, status: `wrote ${imgW}x${imgH}` })
  console.log(`  \$${name.toUpperCase()}  ${diffs.toString().padStart(5)} diffs / ${observed.toString().padStart(5)} observed  (${pct.padStart(7)})`)
}

console.log('\nsummary:')
for (const r of results) {
  console.log(`  \$${r.lvl.toUpperCase()}:  ${r.pct.padStart(7)} match  (${r.diffs} diffs / ${r.observed} cells)  ${r.status}`)
}
