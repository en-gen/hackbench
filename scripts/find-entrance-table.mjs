/**
 * find-entrance-table.mjs
 *
 * USER HINT: YOSHI'S HOUSE = level 104 (decimal).
 * Strategy: use 104 ($68) as an anchor to find the overworld tile→translevel table.
 *
 * In SMW, each overworld tile has an associated "translevel" number (0x000–0x1FF).
 * When the player walks onto a tile and presses A/B, the game loads that translevel.
 * There must be a table (probably 96 or 34 entries) mapping tile slot → translevel.
 *
 * Approaches:
 *   1. Search for $68 as a 1-byte value near other plausible translevel values
 *   2. Search for $68 $00 (LE16 = 104) near other plausible LE16 values
 *   3. Disassemble the code that READS the entrance translevel when A is pressed on overworld
 *   4. Look at the JSL target of the overworld "press A" handler
 *   5. Dump the $E90A context more carefully — is there a PARALLEL table adjacent?
 *
 * Usage:
 *   node scripts/find-entrance-table.mjs <rom.sfc>
 */

import * as fs from 'fs'

const COPIER_HEADER = 512

function loadRom(path) {
  const buf = fs.readFileSync(path)
  const hasHeader = (buf.length % 1024) === COPIER_HEADER
  return { buf, hasHeader }
}
function hex(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, '0') }
function toSnes(off, hasHeader) {
  const o = off - (hasHeader ? COPIER_HEADER : 0)
  const bank = Math.floor(o / 0x8000)
  const addr = 0x8000 + (o % 0x8000)
  return (bank << 16) | addr
}
function fileOf(snes, hasHeader) {
  const bank = (snes >>> 16) & 0x7F
  const addr = snes & 0xFFFF
  if (addr < 0x8000) return addr + (hasHeader ? COPIER_HEADER : 0)
  return bank * 0x8000 + (addr - 0x8000) + (hasHeader ? COPIER_HEADER : 0)
}

function rawDump(buf, hasHeader, label, startSnes, dumpLen) {
  const start = fileOf(startSnes, hasHeader)
  console.log('='.repeat(70))
  console.log(`${label}`)
  console.log(`  SNES $${hex(startSnes,6)}  file $${hex(start,6)}  (${dumpLen} bytes)`)
  console.log('='.repeat(70))
  for (let off = start; off < start + dumpLen && off < buf.length; off += 16) {
    const len = Math.min(16, start + dumpLen - off)
    const row = buf.slice(off, off + len)
    const h = [...row].map(b => hex(b)).join(' ').padEnd(47)
    const a = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
    const snes = toSnes(off, hasHeader)
    console.log(`  $${hex(snes,6)}  ${h}  |${a}|`)
  }
  console.log()
}

const romPath = process.argv[2]
if (!romPath) { console.error('Usage: node scripts/find-entrance-table.mjs <rom.sfc>'); process.exit(1) }
const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}\nSize: ${buf.length} | Header: ${hasHeader ? 'yes' : 'no'}\n`)

const base = hasHeader ? COPIER_HEADER : 0

// ── Known anchor: YOSHI'S HOUSE = translevel 104 ($68) ────────────────────────
// The E90A table: tile type 0 = YOSHI'S HOUSE (name_id=$05, type=1=HOUSE, num=1)
// But wait — tile TYPE 0 in E90A had name_id=$05 which is type=1 (bit0,1=01=HOUSE) num=1
// So tile_type[0] = YOSHI'S HOUSE 1 → should map to translevel $68 (104)
// If we find a table T where T[0] = $68, and T[1], T[2], T[3], T[4] are also
// plausible translevel numbers (< $200) in logical order, that's our table.

const YOSHI_HOUSE_LEVEL = 104  // = $68

console.log('='.repeat(70))
console.log(`SEARCH 1 — 1-byte tables where index 0 = $${hex(YOSHI_HOUSE_LEVEL)} (104)`)
console.log('  (tile_type 0 = YOSHI\'S HOUSE → translevel $68)')
console.log('='.repeat(70))

// Translevels in SMW are 9-bit (0x000–0x1FF). If stored as 1 byte, only 0–$FF fit.
// That covers all 7 regular worlds. Star World and Special World might use extended.
// Let's search for 1-byte tables where [0]=$68 and the first ~8 entries are all < $80.
// Also try $68 at index 0 with values in 0x00–0x7F range.

for (let off = base; off < buf.length - 40; off++) {
  if (buf[off] !== YOSHI_HOUSE_LEVEL) continue
  // Check next 7 bytes: are they all plausible translevel values (< $80, variety)?
  const nearby = [...buf.slice(off, off + 16)]
  const allSmall = nearby.slice(0, 8).every(v => v < 0x80)
  const hasVariety = new Set(nearby.slice(0, 8)).size >= 4
  if (allSmall && hasVariety) {
    const snes = toSnes(off, hasHeader)
    const preview = nearby.map(b => hex(b)).join(' ')
    console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)}: [${preview}]`)
  }
}
console.log()

// ── SEARCH 2: LE16 table where [0] = $0068 ─────────────────────────────────────
console.log('='.repeat(70))
console.log(`SEARCH 2 — 2-byte LE16 tables where index 0 = $${hex(YOSHI_HOUSE_LEVEL,4)} (104)`)
console.log('  (translevel stored as 16-bit)')
console.log('='.repeat(70))

for (let off = base; off < buf.length - 32; off++) {
  const v0 = buf[off] | (buf[off+1] << 8)
  if (v0 !== YOSHI_HOUSE_LEVEL) continue
  const nearby = []
  for (let i = 0; i < 8; i++) nearby.push(buf[off + i*2] | (buf[off + i*2 + 1] << 8))
  const allSmall = nearby.every(v => v < 0x200)
  const hasVariety = new Set(nearby).size >= 4
  if (allSmall && hasVariety) {
    const snes = toSnes(off, hasHeader)
    const preview = nearby.map(v => hex(v, 4)).join(' ')
    console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)}: [${preview}]`)
  }
}
console.log()

// ── SEARCH 3: Look for $68 surrounded by values 0-$7F in overworld code areas ──
// Focus on banks $00, $04, $05 where overworld logic lives.
console.log('='.repeat(70))
console.log('SEARCH 3 — All occurrences of $68 in likely data regions (banks $00, $04, $05)')
console.log('='.repeat(70))

// Bank $00 low area (overworld data): file $0000–$8000
// Bank $04: file $020000–$028000
// Bank $05: file $028000–$030000
const regions = [
  { name: 'bank$00 low', start: base, end: Math.min(base + 0x8000, buf.length) },
  { name: 'bank$04',     start: fileOf(0x048000, hasHeader), end: fileOf(0x050000, hasHeader) },
  { name: 'bank$05',     start: fileOf(0x058000, hasHeader), end: fileOf(0x060000, hasHeader) },
]

for (const { name, start, end } of regions) {
  const hits = []
  for (let off = start; off < Math.min(end, buf.length); off++) {
    if (buf[off] === YOSHI_HOUSE_LEVEL) {
      const ctx = [...buf.slice(Math.max(off-4, start), off+8)].map(b => hex(b)).join(' ')
      const snes = toSnes(off, hasHeader)
      hits.push({ off, snes, ctx })
    }
  }
  console.log(`  ${name}: ${hits.length} hits`)
  for (const { off, snes, ctx } of hits.slice(0, 20)) {
    console.log(`    file $${hex(off,6)} SNES $${hex(snes,6)}: ${ctx}`)
  }
  if (hits.length > 20) console.log(`    ... ${hits.length - 20} more`)
  console.log()
}

// ── SEARCH 4: Examine E90A parallel tables ───────────────────────────────────────
// From earlier work, $00E90A has ~33 valid tile→name_id entries.
// There might be a PARALLEL table adjacent that has tile→translevel.
// Check $00E8EC (E90A - $1E = maybe before), $00E92C (E90A + $22 = after the name table)
rawDump(buf, hasHeader, '$00E880 — 128 bytes before E90A (context)', 0x00E880, 0x90)
rawDump(buf, hasHeader, '$00E90A — 64 bytes (name_id table + after)', 0x00E90A, 0x60)

// ── SEARCH 5: Find overworld "press A" entrance handler ──────────────────────────
// In SMW, when you press A on the overworld, the game reads the current tile's
// translevel from some table. The NMI/IRQ or game loop calls a routine that does:
//   LDA <tile_type>
//   TAX (or TAY)
//   LDA $XXXX,X → translevel
//   STA $0DBF (or similar WRAM location)
// Let's search for the translevel storage: look for code that writes to $0DBF or
// the level number RAM location.
// SMW's level number is stored in WRAM $7E:0DBF (translevel, 9-bit, lo byte) and
// $7E:0DC0 (hi bit). Search for STA $0DBF pattern.
console.log('='.repeat(70))
console.log('SEARCH 5 — Code that stores translevel (STA $0DBF / STA $13BF)')
console.log('  Pattern: 8D BF 0D (STA $0DBF) or 8D BF 13 (STA $13BF)')
console.log('='.repeat(70))

for (let off = base; off < base + 0x8000 - 2; off++) {
  // STA $0DBF
  if (buf[off] === 0x8D && buf[off+1] === 0xBF && buf[off+2] === 0x0D) {
    const snes = toSnes(off, hasHeader)
    const ctx = [...buf.slice(Math.max(off-8,base), off+8)].map(b=>hex(b)).join(' ')
    console.log(`  STA $0DBF at SNES $${hex(snes,6)}: ${ctx}`)
  }
  // STA $13BF
  if (buf[off] === 0x8D && buf[off+1] === 0xBF && buf[off+2] === 0x13) {
    const snes = toSnes(off, hasHeader)
    const ctx = [...buf.slice(Math.max(off-8,base), off+8)].map(b=>hex(b)).join(' ')
    console.log(`  STA $13BF at SNES $${hex(snes,6)}: ${ctx}`)
  }
  // Also try storing to address patterns $0DB1–$0DC0
  if (buf[off] === 0x8D && buf[off+2] === 0x0D && buf[off+1] >= 0xB0 && buf[off+1] <= 0xC0) {
    const addr = buf[off+1] | (0x0D << 8)
    const snes = toSnes(off, hasHeader)
    const ctx = [...buf.slice(Math.max(off-4,base), off+8)].map(b=>hex(b)).join(' ')
    console.log(`  STA $${hex(addr,4)} at SNES $${hex(snes,6)}: ${ctx}`)
  }
}
console.log()

// ── SEARCH 6: Look for the overworld level entrance table at $05E000 area ────────
// SMW's level pointer tables (L1 lo/hi/bank) are at $05E000, $05E200, $05E400.
// The overworld entrance translevel table might be in bank $05 or $04.
// Specifically look for a table where:
//   - Entry 0 = $68 (YOSHI'S HOUSE)
//   - Entries are mostly sequential-ish (0x68, 0x25, 0x26... or similar)
// Also check SNES $05DC00 which is near the level pointer area.
rawDump(buf, hasHeader, '$05DC00 — 256 bytes (overworld entrance area?)', 0x05DC00, 0x100)
rawDump(buf, hasHeader, '$05DB00 — 256 bytes', 0x05DB00, 0x100)

// ── SEARCH 7: The overworld map data in bank $04 ───────────────────────────────
// SMW's overworld data lives in bank $04. The overworld tile/layer data at $04C000+
// Let's look for the entrance table there.
rawDump(buf, hasHeader, '$04C000 — 128 bytes', 0x04C000, 0x80)
rawDump(buf, hasHeader, '$04D000 — 128 bytes', 0x04D000, 0x80)
rawDump(buf, hasHeader, '$04E000 — 128 bytes', 0x04E000, 0x80)

// ── SEARCH 8: Known SMW overworld entrance table locations ───────────────────────
// Community docs suggest the overworld entrance table might be near $04C3CA or similar.
// Let's check $04C3C0 area:
rawDump(buf, hasHeader, '$04C3C0 — 128 bytes (possible entrance table)', 0x04C3C0, 0x80)

// ── SEARCH 9: Search for the sequence 68 25 26 (YOSHI'S HOUSE, then two islands?) ─
// If tile_type 0 = $68 and tile_types 1-4 = YOSHI'S ISLAND 1-4, they might be
// translevels $25, $26, $27, $28 or similar.
// Actually, let's just find all 4-byte windows in the ROM containing $68 where all
// 4 values are in range $00–$7F and all distinct, near each other numerically.
console.log('='.repeat(70))
console.log('SEARCH 9 — 4-byte windows containing $68 where all values are in $00-$7F')
console.log('  (looking for a cluster like: 68 25 26 27 = YH YI1 YI2 YI3)')
console.log('='.repeat(70))

for (let off = base; off < buf.length - 8; off++) {
  const w = [buf[off], buf[off+1], buf[off+2], buf[off+3]]
  if (!w.includes(0x68)) continue
  if (!w.every(v => v < 0x80)) continue
  if (new Set(w).size < 3) continue
  // Check that the values are plausible level numbers (not all the same, some variety)
  const snes = toSnes(off, hasHeader)
  const ctx = [...buf.slice(Math.max(off-2, base), off+8)].map(b => hex(b)).join(' ')
  console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)}: ${ctx}`)
}

console.log('\nDone.')
