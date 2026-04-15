/**
 * dump-level-headers.mjs
 *
 * Reads the primary 5-byte level header for every SMW level (0x000–0x1FF)
 * and dumps all field bits. Used to identify which header byte/bits produce
 * WRAM $192D (FG palette) — the field currently missing from smw-level-header.md.
 *
 * Usage:
 *   node scripts/dump-level-headers.mjs <rom-path>
 *   node scripts/dump-level-headers.mjs <rom-path> --levels 025,009,007,01D
 *
 * Output:
 *   TSV: level | ptr | b0 | b1 | b2 | b3 | b4 | decoded fields | raw bits
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

function hasCopierHeader(size) { return (size % 1024) === 512 }

function bits(byte, hi, lo) {
  const mask = (1 << (hi - lo + 1)) - 1
  return (byte >>> lo) & mask
}

function bin8(v) {
  return v.toString(2).padStart(8, '0')
}

// ── Parse command line ────────────────────────────────────────────────────────
const [, , romPath, ...rest] = process.argv
if (!romPath) {
  console.error('Usage: node scripts/dump-level-headers.mjs <rom-path> [--levels 025,009,007]')
  process.exit(1)
}

let levelFilter = null
const levelsArg = rest.find(a => a.startsWith('--levels=') || a === '--levels')
if (levelsArg === '--levels') {
  const idx = rest.indexOf('--levels')
  levelFilter = new Set(rest[idx + 1]?.split(',').map(s => parseInt(s, 16)) ?? [])
} else if (levelsArg?.startsWith('--levels=')) {
  levelFilter = new Set(levelsArg.slice(9).split(',').map(s => parseInt(s, 16)))
}

// ── Load ROM ──────────────────────────────────────────────────────────────────
const buf = fs.readFileSync(romPath)
const hasHeader = hasCopierHeader(buf.length)
console.error(`ROM: ${romPath}  (${buf.length} bytes, ${hasHeader ? 'has' : 'no'} copier header)`)

// ── Print header ──────────────────────────────────────────────────────────────
const COLS = [
  'LVL', 'PTR', 'B0', 'B1', 'B2', 'B3', 'B4',
  'bgPal', 'screens', 'bgColor', 'lvlMode', 'music', 'b2[3:0]',
  'timeLimit', 'sprPal', 'sprSet', 'itemMem', 'vScroll', 'bgType',
  'B0bits', 'B1bits', 'B2bits', 'B3bits', 'B4bits',
]
console.log(COLS.join('\t'))

// ── Iterate levels 0x000–0x1FF ────────────────────────────────────────────────
// Pointer table is interleaved 3-byte entries (lo, hi, bank) at $05E000 + level*3.
// 512 levels × 3 bytes = $600 bytes ($05E000–$05E5FF).
const LEVEL_COUNT  = 0x200
const L1_PTR_TABLE = 0x05E000

for (let lvl = 0; lvl < LEVEL_COUNT; lvl++) {
  if (levelFilter && !levelFilter.has(lvl)) continue

  // 3-byte interleaved pointer: [lo, hi, bank] at base + level*3
  const ptrBytes = readAt(buf, L1_PTR_TABLE + lvl * 3, 3, hasHeader)
  if (!ptrBytes) continue
  const snesPtr = (ptrBytes[2] << 16) | (ptrBytes[1] << 8) | ptrBytes[0]

  const hdr = readAt(buf, snesPtr, 5, hasHeader)
  if (!hdr) continue

  const [b0, b1, b2, b3, b4] = hdr

  // Decoded fields (from smw-level-header.md)
  const bgPal      = bits(b0, 7, 5)   // byte 0 bits 7–5
  const screens    = bits(b0, 4, 0) + 1  // byte 0 bits 4–0 (+ 1)
  const bgColor    = bits(b1, 7, 5)   // byte 1 bits 7–5
  const lvlMode    = bits(b1, 4, 0)   // byte 1 bits 4–0
  const layer3pri  = bits(b2, 7, 7)   // byte 2 bit 7
  const music      = bits(b2, 6, 4)   // byte 2 bits 6–4
  const b2lo4      = bits(b2, 3, 0)   // byte 2 bits 3–0 ("unused/ext" — FG palette candidate)
  const timeLimit  = bits(b3, 7, 6)   // byte 3 bits 7–6
  const sprPal     = bits(b3, 5, 4)   // byte 3 bits 5–4
  const sprSet     = bits(b3, 3, 0)   // byte 3 bits 3–0
  const itemMem    = bits(b4, 7, 6)   // byte 4 bits 7–6
  const vScroll    = bits(b4, 5, 4)   // byte 4 bits 5–4
  const bgType     = bits(b4, 3, 0)   // byte 4 bits 3–0

  const row = [
    lvl.toString(16).toUpperCase().padStart(3, '0'),
    snesPtr.toString(16).toUpperCase().padStart(6, '0'),
    b0.toString(16).padStart(2, '0').toUpperCase(),
    b1.toString(16).padStart(2, '0').toUpperCase(),
    b2.toString(16).padStart(2, '0').toUpperCase(),
    b3.toString(16).padStart(2, '0').toUpperCase(),
    b4.toString(16).padStart(2, '0').toUpperCase(),
    bgPal, screens, bgColor, lvlMode, music, b2lo4,
    timeLimit, sprPal, sprSet, itemMem, vScroll, bgType,
    bin8(b0), bin8(b1), bin8(b2), bin8(b3), bin8(b4),
  ]
  console.log(row.join('\t'))
}
