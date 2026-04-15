/**
 * dump-palette.mjs
 *
 * Reads the SMW palette entries from a ROM file and outputs all 16 CGRAM rows
 * as RGBA values — suitable for comparison against Mesen2's CGRAM viewer.
 *
 * Usage:
 *   node scripts/dump-palette.mjs <rom-path>
 *   node scripts/dump-palette.mjs <rom-path> --format hex
 *
 * Output formats:
 *   default  — RGB hex swatches like #RRGGBB
 *   hex      — raw BGR555 word values
 *   rgb      — decimal R,G,B triples
 */

import * as fs from 'fs'

// ── LoROM address → file offset ───────────────────────────────────────────────
function loromToOffset(snesAddr, hasHeader) {
  const bank         = (snesAddr >>> 16) & 0xFF
  const addr         = snesAddr & 0xFFFF
  const effectiveBank = bank & 0x7F

  let offset
  if (effectiveBank <= 0x3F) {
    if (addr < 0x8000) return null
    offset = effectiveBank * 0x8000 + (addr - 0x8000)
  } else if (effectiveBank <= 0x6F) {
    offset = (effectiveBank - 0x40) * 0x10000 + addr
  } else {
    return null
  }
  return offset + (hasHeader ? 512 : 0)
}

function readAt(buf, snesAddr, len, hasHeader) {
  const off = loromToOffset(snesAddr, hasHeader)
  if (off === null || off + len > buf.length) return null
  return buf.slice(off, off + len)
}

function hasCopierHeader(size) {
  return (size % 1024) === 512
}

// ── BGR555 → RGB8 ─────────────────────────────────────────────────────────────
function bgr555ToRgb(v) {
  const r5 = (v)       & 0x1F
  const g5 = (v >>  5) & 0x1F
  const b5 = (v >> 10) & 0x1F
  return [(r5 << 3) | (r5 >> 2), (g5 << 3) | (g5 >> 2), (b5 << 3) | (b5 >> 2)]
}

function toHex6(r, g, b) {
  return '#' + [r, g, b].map(c => c.toString(16).padStart(2, '0')).join('')
}

// ── Read 12-color palette entry (24 bytes), colors at indices 1-12 ────────────
function readEntry12(buf, snesAddr, hasHeader) {
  const data = readAt(buf, snesAddr, 24, hasHeader)
  const colors = new Array(16).fill(null)  // index 0 = transparent
  if (!data) return colors
  for (let i = 0; i < 12; i++) {
    const word = data.readUInt16LE(i * 2)
    colors[i + 1] = { word, rgb: bgr555ToRgb(word) }
  }
  return colors
}

// ── Read 10-color palette entry (20 bytes), colors at indices 1-10 ────────────
function readEntry10(buf, snesAddr, hasHeader) {
  const data = readAt(buf, snesAddr, 20, hasHeader)
  const colors = new Array(16).fill(null)
  if (!data) return colors
  for (let i = 0; i < 10; i++) {
    const word = data.readUInt16LE(i * 2)
    colors[i + 1] = { word, rgb: bgr555ToRgb(word) }
  }
  return colors
}

// ── Format a row of 16 colors for output ──────────────────────────────────────
function formatRow(label, colors, fmt) {
  const parts = colors.map((c, i) => {
    if (i === 0) return '(transparent)'
    if (!c) return '(unknown)    '
    if (fmt === 'hex')  return `$${c.word.toString(16).padStart(4, '0').toUpperCase()}`
    if (fmt === 'rgb')  return `(${c.rgb.join(',').padEnd(11)})`
    return toHex6(...c.rgb)
  })
  return `${label.padEnd(28)}: ${parts.join('  ')}`
}

// ── Main ──────────────────────────────────────────────────────────────────────
const [, , romPath, fmtArg] = process.argv
const fmt = fmtArg === '--format' ? (process.argv[4] ?? 'swatch') : (fmtArg?.startsWith('--format=') ? fmtArg.slice(9) : 'swatch')

if (!romPath) {
  console.error('Usage: node scripts/dump-palette.mjs <rom-path> [--format hex|rgb|swatch]')
  process.exit(1)
}

const buf = fs.readFileSync(romPath)
const hasHeader = hasCopierHeader(buf.length)
console.log(`ROM: ${romPath}  (${buf.length} bytes, ${hasHeader ? 'has' : 'no'} copier header)`)
console.log()

// ── Back area color ───────────────────────────────────────────────────────────
const backBuf = readAt(buf, 0x00B0A0, 2, hasHeader)
if (backBuf) {
  const w = backBuf.readUInt16LE(0)
  const [r, g, b] = bgr555ToRgb(w)
  console.log(`Back area color ($B0A0): $${w.toString(16).padStart(4,'0').toUpperCase()} = ${toHex6(r,g,b)}`)
  console.log()
}

// ── BG palette rows 0-1 (variant 0) ──────────────────────────────────────────
console.log('=== BG Palette (CGRAM rows 0–1) ===')
console.log(formatRow('Row 0 var0 ($B0B0)',  readEntry12(buf, 0x00B0B0, hasHeader), fmt))
console.log(formatRow('Row 1 var0 ($B0C8)',  readEntry12(buf, 0x00B0C8, hasHeader), fmt))
console.log()

// ── BG palette intermediate region ($B0E0–$B18F, 24-byte entries) ─────────────
console.log('=== BG Palette Intermediate Region ($B0E0–$B18F) ===')
for (let i = 0; i * 24 < 0x00B190 - 0x00B0E0; i++) {
  const addr = 0x00B0E0 + i * 24
  console.log(formatRow(`Entry ${i} ($${addr.toString(16).toUpperCase()})`,
    readEntry12(buf, addr, hasHeader), fmt))
}
console.log()

// ── FG palette rows 2-3 (variant 0) ──────────────────────────────────────────
console.log('=== FG Palette variant 0 (CGRAM rows 2–3) ===')
console.log(formatRow('Row 2 var0 ($B190)',  readEntry12(buf, 0x00B190, hasHeader), fmt))
console.log(formatRow('Row 3 var0 ($B1A8)',  readEntry12(buf, 0x00B1A8, hasHeader), fmt))
console.log()

// ── Possible FG palette variants ($B1C0–$B2C7) ───────────────────────────────
// Structure: not fully verified — could be FG variants 1-7, or misc sprite rows.
// Showing all entries; compare against Mesen CGRAM rows 2-3 while in different levels.
console.log('=== Possible FG Palette Variants ($B1C0–$B2C7, 24-byte entries) ===')
for (let i = 0; i * 24 < 0x00B2C8 - 0x00B1C0; i++) {
  const addr = 0x00B1C0 + i * 24
  console.log(formatRow(`Entry ${i} ($${addr.toString(16).toUpperCase()})`,
    readEntry12(buf, addr, hasHeader), fmt))
}
console.log()

// ── Player palettes ───────────────────────────────────────────────────────────
console.log('=== Player Palettes (CGRAM row 13) ===')
console.log(formatRow('Mario ($B2C8)',       readEntry10(buf, 0x00B2C8, hasHeader), fmt))
console.log(formatRow('Luigi ($B2DC)',       readEntry10(buf, 0x00B2DC, hasHeader), fmt))
console.log(formatRow('Fire Mario ($B2F0)',  readEntry10(buf, 0x00B2F0, hasHeader), fmt))
console.log(formatRow('Fire Luigi ($B304)',  readEntry10(buf, 0x00B304, hasHeader), fmt))
console.log()

// ── Sprite palette E + F ──────────────────────────────────────────────────────
console.log('=== Sprite Palette E / F (CGRAM rows 14–15) ===')
console.log(formatRow('Palette E ($B318)',   readEntry12(buf, 0x00B318, hasHeader), fmt))
console.log(formatRow('Palette F ($B330)',   readEntry12(buf, 0x00B330, hasHeader), fmt))
console.log()

// ── Sprite palette sets 0-7 (rows 4-8 each) ──────────────────────────────────
console.log('=== Sprite Palette Sets 0–7 (CGRAM rows 4–8) ===')
for (let set = 0; set < 8; set++) {
  const base = 0x00B348 + set * 5 * 24
  console.log(`  Set ${set} (base $${base.toString(16).toUpperCase()}):`)
  for (let r = 0; r < 5; r++) {
    const addr = base + r * 24
    console.log(formatRow(`    Row ${4 + r} ($${addr.toString(16).toUpperCase()})`,
      readEntry12(buf, addr, hasHeader), fmt))
  }
}
console.log()

console.log('Done.')
