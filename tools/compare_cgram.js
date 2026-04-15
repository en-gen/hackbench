/**
 * compare_cgram.js
 * Compares a live CGRAM dump (from cgram_dump_live.lua) against
 * what our PaletteLoader.ts would produce for a given level.
 *
 * Usage:
 *   node tools/compare_cgram.js <levelIndex_hex> <cgram_dump.txt>
 *   node tools/compare_cgram.js 104 tools/cgram_104_yoshi_house.txt
 *
 * The dump file must contain lines of the form:
 *   row XX: w0 w1 w2 ... w15
 * where each wN is a 4-digit hex CGRAM word value (as shown by Mesen Palette Viewer).
 * Output from cgram_dump_live.lua already uses this format.
 *
 * The old cgram_104_yoshi_house.txt uses the BYTE-PAIR format (little-endian byte order).
 * Pass --byte-pairs flag if your dump uses that format.
 */

const fs = require('fs')
const path = require('path')

// ── Parse args ────────────────────────────────────────────────────────────────
const args = process.argv.slice(2).filter(a => !a.startsWith('--'))
const flags = new Set(process.argv.slice(2).filter(a => a.startsWith('--')))
const bytePairs = flags.has('--byte-pairs')

if (args.length < 2) {
  console.error('Usage: node compare_cgram.js <levelIndex_hex> <dump.txt> [--byte-pairs]')
  process.exit(1)
}
const levelIndex = parseInt(args[0], 16)
const dumpFile   = args[1]

// ── Load ROM ──────────────────────────────────────────────────────────────────
const romDir = path.join(__dirname, '..', 'test', 'roms')
let romPath = null
try {
  const files = fs.readdirSync(romDir)
  const rom = files.find(f => /\.(smc|sfc|rom)$/i.test(f))
  if (rom) romPath = path.join(romDir, rom)
} catch (e) {}
if (!romPath) { console.error('ROM not found in test/roms/'); process.exit(1) }

const buf = fs.readFileSync(romPath)
const hasHeader = buf.length % 1024 === 512
const headerOff = hasHeader ? 512 : 0

function snesOff(snes) {
  const bank = (snes >> 16) & 0x7F
  const addr = snes & 0xFFFF
  return headerOff + bank * 0x8000 + (addr - 0x8000)
}
function romRead16(snes) {
  const off = snesOff(snes)
  return buf.readUInt16LE(off)
}
function romReadN(snes, n) {
  const off = snesOff(snes)
  return Array.from({ length: n }, (_, i) => buf.readUInt16LE(off + i * 2))
}

// ── Parse CGRAM dump ──────────────────────────────────────────────────────────
const dumpLines = fs.readFileSync(dumpFile, 'utf8').split('\n')
const dumpRows = new Map()
for (const line of dumpLines) {
  const m = line.match(/row\s+([0-9A-Fa-f]{2})\s*:\s*(.+)/)
  if (!m) continue
  const rowIdx = parseInt(m[1], 16)
  const words = m[2].trim().split(/\s+/).map(h => {
    if (bytePairs) {
      // Byte-pair format: '4239' = bytes [0x42, 0x39] → LE16 word 0x3942
      const lo = parseInt(h.slice(0, 2), 16)
      const hi = parseInt(h.slice(2, 4), 16)
      return (hi << 8) | lo
    } else {
      // Direct word format (output of cgram_dump_live.lua)
      return parseInt(h, 16)
    }
  })
  dumpRows.set(rowIdx, words)
}
if (dumpRows.size === 0) {
  console.error('No palette rows found in', dumpFile)
  process.exit(1)
}
console.log(`Loaded ${dumpRows.size} rows from ${path.basename(dumpFile)}${bytePairs ? ' (byte-pair mode)' : ''}`)

// ── Read level header ─────────────────────────────────────────────────────────
const l1PtrBase = snesOff(0x05E000 + levelIndex * 3)
const l1Snes = (buf[l1PtrBase + 2] << 16) | (buf[l1PtrBase + 1] << 8) | buf[l1PtrBase]
const l1Off = snesOff(l1Snes)
const h = [buf[l1Off], buf[l1Off+1], buf[l1Off+2], buf[l1Off+3], buf[l1Off+4]]
const bgPalette  = (h[0] >> 5) & 0x7
const spriteSet  = h[3] & 0xF
const marioVar   = 0  // default Mario
console.log(`Level $${levelIndex.toString(16).toUpperCase()}: bgPalette=${bgPalette} spriteSet=${spriteSet}\n`)

// ── ROM palette addresses ─────────────────────────────────────────────────────
const ADDR_BG0         = 0x00B0B0
const ADDR_BG1         = 0x00B0C8
const ADDR_BG_EXTRA    = 0x00B0E0  // variants 1+ for rows 0-1
const ADDR_FG0         = 0x00B190
const ADDR_FG1         = 0x00B1A8
const ADDR_FG_EXTRA    = 0x00B1C0  // FG extra variants
const ADDR_PLAYER      = 0x00B2C8
const ADDR_SP_E        = 0x00B318
const ADDR_SP_F        = 0x00B330
const ADDR_SPRITE_SETS = 0x00B348
const PALETTE_COLORS   = 12   // currently 12 (should be 15, but reading 12 for now)
const PALETTE_BYTES    = PALETTE_COLORS * 2
const SPRITE_SET_BYTES = 5 * PALETTE_BYTES

// Build the CGRAM our code would produce (only the colors it currently loads)
// Row:  0=BG0, 1=BG1, 2=FG0, 3=FG1, 4-8=spriteSet×5, 13=player, 14=spE, 15=spF
// Missing: rows 9-12

function emptyRow() { return new Array(16).fill(0) }
function readRomRow(snesAddr, numColors = PALETTE_COLORS) {
  const row = emptyRow()
  const words = romReadN(snesAddr, numColors)
  for (let i = 0; i < numColors; i++) row[i + 1] = words[i]
  return row
}

const ourCgram = Array.from({ length: 16 }, emptyRow)

// Rows 0-1 (BG)
const bg0Addr = bgPalette === 0 ? ADDR_BG0 : ADDR_BG_EXTRA + (bgPalette - 1) * 2 * PALETTE_BYTES
const bg1Addr = bgPalette === 0 ? ADDR_BG1 : ADDR_BG_EXTRA + (bgPalette - 1) * 2 * PALETTE_BYTES + PALETTE_BYTES
ourCgram[0] = readRomRow(ADDR_BG0)       // always variant 0 currently
ourCgram[1] = readRomRow(ADDR_BG1)

// Rows 2-3 (FG)
ourCgram[2] = readRomRow(ADDR_FG0)
ourCgram[3] = readRomRow(ADDR_FG1)

// Rows 4-8 (sprite set)
const spBase = ADDR_SPRITE_SETS + spriteSet * SPRITE_SET_BYTES
for (let r = 0; r < 5; r++) ourCgram[4 + r] = readRomRow(spBase + r * PALETTE_BYTES)

// Row 13 (player)
const playerAddr = ADDR_PLAYER + marioVar * 20
ourCgram[13] = readRomRow(playerAddr, 10)

// Row 14-15 (sp E/F)
ourCgram[14] = readRomRow(ADDR_SP_E)
ourCgram[15] = readRomRow(ADDR_SP_F)

// ── Compare ───────────────────────────────────────────────────────────────────
const ROW_LABELS = [
  'BG row 0', 'BG row 1', 'FG row 2', 'FG row 3',
  'Sprite set row 4', 'Sprite set row 5', 'Sprite set row 6', 'Sprite set row 7', 'Sprite set row 8',
  '⚠ NOT LOADED (row 9)', '⚠ NOT LOADED (row A)', '⚠ NOT LOADED (row B)', '⚠ NOT LOADED (row C)',
  'Player (row D)', 'Sprite E (row E)', 'Sprite F (row F)',
]

let totalColors = 0, matchedColors = 0
console.log('=== CGRAM Comparison: Our PaletteLoader vs Mesen dump ===')
console.log('Notation: [col] OUR=$xxxx MESEN=$yyyy')
console.log('')

for (let r = 0; r < 16; r++) {
  const dump = dumpRows.get(r)
  if (!dump) { console.log(`Row ${r.toString(16).toUpperCase()}: not in dump`); continue }
  const our = ourCgram[r]
  const mismatches = []
  let rowMatch = 0
  for (let c = 0; c < 16; c++) {
    totalColors++
    if (our[c] === dump[c]) { rowMatch++; matchedColors++ }
    else mismatches.push({ c, our: our[c], dump: dump[c] })
  }
  const label = ROW_LABELS[r] || `Row ${r}`
  const status = rowMatch === 16 ? '✓ ALL MATCH' : `${rowMatch}/16 match`
  console.log(`Row ${r.toString(16).toUpperCase()} (${label}): ${status}`)
  for (const { c, our, dump } of mismatches) {
    console.log(`  [${c.toString(16).toUpperCase()}] ours=$${our.toString(16).padStart(4,'0')}  mesen=$${dump.toString(16).padStart(4,'0')}`)
  }
}

console.log('')
console.log(`Overall: ${matchedColors}/${totalColors} colors match (${Math.round(matchedColors/totalColors*100)}%)`)
console.log('')
console.log('Rows 9-12 are NOT loaded by PaletteLoader (known bug) — mismatches there are expected.')
