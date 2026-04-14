/**
 * Dump raw decompressed bytes for a GFX file — helps identify the data format
 * when the standard 2bpp/3bpp/4bpp decoders all produce scrambled output.
 *
 * Usage:
 *   node scripts/dump-gfx-raw.mjs <rom.sfc> <gfx-index-decimal>
 *   node scripts/dump-gfx-raw.mjs rom.sfc 39    ← GFX27 hex
 */

import { readFileSync } from 'fs'

const romPath = process.argv[2]
const gfxIdx  = parseInt(process.argv[3] ?? '39', 10)
if (!romPath || isNaN(gfxIdx)) {
  console.error('Usage: node dump-gfx-raw.mjs <rom.sfc> <gfx-index>')
  process.exit(1)
}

const raw      = readFileSync(romPath)
const hasHdr   = (raw.length % 1024) === 512
const hdrOff   = hasHdr ? 512 : 0

function lorom(addr) {
  const bank = (addr >>> 16) & 0x7F
  const off  = addr & 0xFFFF
  if (bank > 0x3F || off < 0x8000) return null
  return hdrOff + bank * 0x8000 + (off - 0x8000)
}
function rb(a) { const o = lorom(a); return o !== null ? raw[o] : null }
function readAt(a, n) { const o = lorom(a); return o !== null ? raw.subarray(o, o + n) : null }

// LC_LZ2 decompressor
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

const GFX_LO = 0x00B992, GFX_HI = 0x00B9C4, GFX_BK = 0x00B9F6
const lo = rb(GFX_LO + gfxIdx), hi = rb(GFX_HI + gfxIdx), bank = rb(GFX_BK + gfxIdx)
const snes = (bank << 16) | (hi << 8) | lo
console.log(`GFX${gfxIdx.toString(16).toUpperCase().padStart(2,'0')} (index ${gfxIdx}) → SNES $${snes.toString(16).toUpperCase().padStart(6,'0')}`)

const data = decompress(readAt(snes, 0x4000))
console.log(`Decompressed: ${data.length} bytes`)
console.log(`  ÷16 = ${data.length/16} tiles (2bpp)`)
console.log(`  ÷24 = ${(data.length/24).toFixed(2)} tiles (3bpp)`)
console.log(`  ÷32 = ${data.length/32} tiles (4bpp)`)
console.log(`  ÷64 = ${data.length/64} tiles (8bpp / Mode7)`)
console.log()

// Check if the data looks "structured" — count distinct byte values, runs, etc.
const counts = new Uint32Array(256)
for (const b of data) counts[b]++
const nonZero = counts.filter(c => c > 0).length
console.log(`Distinct byte values: ${nonZero} / 256`)
console.log(`Zero bytes: ${counts[0]} (${(counts[0]/data.length*100).toFixed(1)}%)`)
console.log(`0xFF bytes: ${counts[255]} (${(counts[255]/data.length*100).toFixed(1)}%)`)
console.log()

// Entropy check — high entropy (~8 bits) = compressed/random; low = structured tile data
// Tile bitplanes typically have many 0x00 and 0xFF bytes
const topBytes = [...counts.entries()]
  .filter(([,c]) => c > 0)
  .sort((a,b) => b[1]-a[1])
  .slice(0, 16)
console.log('Most common bytes:')
for (const [b, c] of topBytes) {
  const pct = (c / data.length * 100).toFixed(1)
  console.log(`  0x${b.toString(16).padStart(2,'0')} : ${c.toString().padStart(5)} (${pct}%)`)
}
console.log()

// Dump first 256 bytes as hex
console.log('First 256 bytes (hex):')
for (let row = 0; row < 16; row++) {
  const hex = []
  for (let col = 0; col < 16; col++) hex.push(data[row*16+col].toString(16).padStart(2,'0'))
  console.log(`  ${(row*16).toString(16).padStart(3,'0')}: ${hex.join(' ')}`)
}
console.log()

// Check if it could be Mode 7 (8bpp linear) — each byte is a pixel value
// Mode 7 tiles are 8x8 stored row by row (8 bytes/row, 64 bytes/tile)
if (data.length % 64 === 0) {
  console.log(`Mode7 (8bpp linear): ${data.length/64} tiles of 8×8`)
  console.log('First tile, row 0 (8 pixel values):',
    Array.from(data.subarray(0, 8)).map(b => b.toString(16).padStart(2,'0')).join(' '))
}

// Check for repeating 16-byte (2bpp tile row) patterns
let runs = 0, prev = -1
for (const b of data) { if (b !== prev) runs++; prev = b }
console.log(`Run-length estimate: ${runs} runs over ${data.length} bytes (ratio ${(data.length/runs).toFixed(1)}x)`)
console.log('Low ratio ≈ noisy; high ratio ≈ structured/compressible')
