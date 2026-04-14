/**
 * Decompress a GFX file and write it as a PPM image (16 tiles wide).
 * Use palette index 0 = black, 1-15 = shades of gray/color so shapes are visible
 * regardless of which CGRAM row is "correct".
 *
 * PPM can be opened in GIMP, IrfanView, Paint.NET, or any basic viewer.
 *
 * Usage:
 *   node scripts/dump-gfx-image.mjs <rom.sfc> <gfx-index-decimal> [out.ppm]
 *   node scripts/dump-gfx-image.mjs rom.sfc 0 gfx00.ppm
 *   node scripts/dump-gfx-image.mjs rom.sfc 32 gfx20.ppm   ← the 3bpp one
 */

import { readFileSync, writeFileSync } from 'fs'

const romPath  = process.argv[2]
const gfxIdx   = parseInt(process.argv[3] ?? '0', 10)
const outPath  = process.argv[4] ?? `gfx${gfxIdx.toString(16).padStart(2,'0')}.ppm`

if (!romPath || isNaN(gfxIdx)) {
  console.error('Usage: node dump-gfx-image.mjs <rom.sfc> <gfx-index> [out.ppm]')
  process.exit(1)
}

const raw = readFileSync(romPath)
const hasHeader = (raw.length % 1024) === 512
const hdrOff    = hasHeader ? 512 : 0

function loromToOffset(snesAddr) {
  const bank = (snesAddr >>> 16) & 0x7F
  const addr  = snesAddr & 0xFFFF
  if (bank > 0x3F || addr < 0x8000) return null
  return hdrOff + bank * 0x8000 + (addr - 0x8000)
}
function readByte(a) { const o = loromToOffset(a); return o !== null ? raw[o] : null }
function readAt(a, n) { const o = loromToOffset(a); return o !== null ? raw.subarray(o, o + n) : null }

// ── LC_LZ2 decompressor ───────────────────────────────────────────────────────
function decompress(src) {
  const out = []; let i = 0
  while (i < src.length) {
    const h = src[i++]; if (h === 0xFF) break
    let cmd = (h >> 5) & 7, len
    if (cmd === 7) { const e = src[i++]; cmd = (h >> 2) & 7; len = ((h & 3) << 8 | e) + 1 }
    else           { len = (h & 0x1F) + 1 }
    switch (cmd) {
      case 0: for (let n=0;n<len&&i<src.length;n++) out.push(src[i++]); break
      case 1: { const b=src[i++]; for (let n=0;n<len;n++) out.push(b); break }
      case 2: { const b0=src[i++],b1=src[i++]; for(let n=0;n<len;n++) out.push(n%2?b1:b0); break }
      case 3: { let b=src[i++]; for(let n=0;n<len;n++) out.push(b++&0xFF); break }
      case 4: { const hi=src[i++],lo=src[i++],addr=(hi<<8)|lo; for(let n=0;n<len;n++) out.push(addr+n<out.length?out[addr+n]:0); break }
    }
  }
  return Uint8Array.from(out)
}

// ── Pointer tables ─────────────────────────────────────────────────────────────
const GFX_PTR_LO   = 0x00B992
const GFX_PTR_HI   = 0x00B9C4
const GFX_PTR_BANK = 0x00B9F6

const lo   = readByte(GFX_PTR_LO   + gfxIdx)
const hi   = readByte(GFX_PTR_HI   + gfxIdx)
const bank = readByte(GFX_PTR_BANK + gfxIdx)
const snes = (bank << 16) | (hi << 8) | lo
console.log(`GFX${gfxIdx.toString(16).padStart(2,'0').toUpperCase()} → $${snes.toString(16).toUpperCase().padStart(6,'0')}`)

const compressed   = readAt(snes, 0x2000)
const decompressed = decompress(compressed)
console.log(`Decompressed: ${decompressed.length} bytes`)

// ── Decode tiles ──────────────────────────────────────────────────────────────
const IS_3BPP  = (gfxIdx === 32)
const BPT      = IS_3BPP ? 24 : 32
const TILE_COUNT = Math.floor(decompressed.length / BPT)
console.log(`Tiles: ${TILE_COUNT} (${IS_3BPP ? '3bpp' : '4bpp'}, ${BPT} bytes each)`)

// Decode 4bpp tile: returns 64 palette indices (0-15)
function decode4bpp(data, off) {
  const px = new Uint8Array(64)
  for (let row = 0; row < 8; row++) {
    const p0lo = data[off + row * 2]
    const p0hi = data[off + row * 2 + 1]
    const p1lo = data[off + 16 + row * 2]
    const p1hi = data[off + 16 + row * 2 + 1]
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col
      px[row * 8 + col] =
        ((p0lo >> bit) & 1)       |
        (((p0hi >> bit) & 1) << 1) |
        (((p1lo >> bit) & 1) << 2) |
        (((p1hi >> bit) & 1) << 3)
    }
  }
  return px
}

// Decode 3bpp tile: returns 64 palette indices (0-7)
function decode3bpp(data, off) {
  const px = new Uint8Array(64)
  for (let row = 0; row < 8; row++) {
    const p0lo = data[off + row * 2]
    const p0hi = data[off + row * 2 + 1]
    const p2   = data[off + 16 + row]
    for (let col = 0; col < 8; col++) {
      const bit = 7 - col
      px[row * 8 + col] =
        ((p0lo >> bit) & 1)       |
        (((p0hi >> bit) & 1) << 1) |
        (((p2   >> bit) & 1) << 2)
    }
  }
  return px
}

const tiles = []
for (let t = 0; t < TILE_COUNT; t++) {
  tiles.push(IS_3BPP ? decode3bpp(decompressed, t * BPT) : decode4bpp(decompressed, t * BPT))
}

// ── Also decode with WRONG method to compare ──────────────────────────────────
// If the "wrong" decode produces the same result as "right", the issue is elsewhere
if (!IS_3BPP) {
  // Decode first tile as if it were 3bpp, print both side by side for row 0
  const t4 = decode4bpp(decompressed, 0)
  const t3 = decode3bpp(decompressed, 0)
  console.log('\nFirst tile row 0:')
  console.log('  4bpp:', Array.from(t4.subarray(0, 8)).join(' '))
  console.log('  3bpp:', Array.from(t3.subarray(0, 8)).join(' '))
}

// ── Render to PPM ─────────────────────────────────────────────────────────────
// 16 tiles per row; each tile 8×8 pixels.
// Color map: index 0 = dark gray (transparent placeholder), 1-15 = distinct colors
// so shapes are visible regardless of palette assignment.
const COLS = 16
const ROWS = Math.ceil(TILE_COUNT / COLS)
const W = COLS * 8
const H = ROWS * 8

// Distinct colors for palette indices 0-15 (arbitrary but unique)
const PALETTE = [
  [40,  40,  40 ],  // 0  — transparent (dark gray)
  [255, 255, 255],  // 1  — white
  [200, 200, 200],  // 2  — light gray
  [150, 150, 150],  // 3  — mid gray
  [255,   0,   0],  // 4  — red
  [200,   0,   0],  // 5  — dark red
  [  0, 200,   0],  // 6  — green
  [  0, 150,   0],  // 7  — dark green
  [  0,   0, 255],  // 8  — blue
  [  0,   0, 200],  // 9  — dark blue
  [255, 255,   0],  // 10 — yellow
  [200, 150,   0],  // 11 — orange
  [255,   0, 255],  // 12 — magenta
  [  0, 200, 200],  // 13 — cyan
  [255, 150, 100],  // 14 — peach
  [150,  50, 200],  // 15 — purple
]

const img = Buffer.alloc(W * H * 3)

for (let t = 0; t < tiles.length; t++) {
  const tileCol = t % COLS
  const tileRow = Math.floor(t / COLS)
  const tile = tiles[t]
  for (let py = 0; py < 8; py++) {
    for (let px = 0; px < 8; px++) {
      const idx   = tile[py * 8 + px]
      const color = PALETTE[idx] ?? PALETTE[0]
      const dest  = ((tileRow * 8 + py) * W + tileCol * 8 + px) * 3
      img[dest]     = color[0]
      img[dest + 1] = color[1]
      img[dest + 2] = color[2]
    }
  }
}

// PPM header + pixels
const header = `P6\n${W} ${H}\n255\n`
writeFileSync(outPath, Buffer.concat([Buffer.from(header), img]))
console.log(`\nWrote ${outPath} (${W}×${H} px, ${TILE_COUNT} tiles)`)
console.log('Open in GIMP, IrfanView, or Paint.NET to compare against Mesen2 tile viewer.')
