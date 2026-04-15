/**
 * find-level-name-table.mjs
 *
 * INSIGHT: Search for CONSECUTIVE known level name sequences.
 * "YOSHI'S ISLAND 1", "YOSHI'S ISLAND 2", "YOSHI'S ISLAND 3", "YOSHI'S ISLAND 4"
 * must appear consecutively (or near each other) in the composition table.
 *
 * Using seq IDs: YOSHI'S=0, ISLAND=30=$1E, digit tiles 1-5 = $38-$3C
 * Look for [00 1E 38] [00 1E 39] [00 1E 3A] [00 1E 3B] (3-byte entries)
 * Or [00 1E] [00 1E] [00 1E] [00 1E] if digits are separate.
 *
 * Also look for [09 21 38] [09 21 39] etc. = "DONUT PLAINS 1", "DONUT PLAINS 2"...
 *
 * Also attempt to decode the data at $00A920 and $00B276 more fully.
 *
 * Also: look for 1-byte-per-slot tables that could encode level names via world+type.
 *
 * Usage:
 *   node scripts/find-level-name-table.mjs <rom.sfc>
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

// Confirmed seq IDs:
const YOSHI_S = 0x00   // YOSHI'S
const ISLAND  = 0x1E   // seq[30]
const HOUSE   = 0x1D   // seq[29]
const DONUT   = 0x09   // seq[9]
const PLAINS  = 0x21   // seq[33]
const VANILLA = 0x0C   // seq[12]
const DOME    = 0x24   // seq[36]
const VALLEY  = 0x17   // seq[23]
const OF_BOWSER = 0x28 // seq[40]
const CASTLE  = 0x20   // seq[32]
const GHOST_HOUSE = 0x22 // seq[34]
const IGGY    = 0x02   // seq[2]
const MORTON  = 0x03   // seq[3]
const CHOCOLATE = 0x14 // seq[20]
const SECRET  = 0x23   // seq[35]
const FOREST  = 0x13   // seq[19]

// Digit tiles in SMW tile encoding: $38=$1, $39=$2, $3A=$3, $3B=$4, $3C=$5
const D1 = 0x38, D2 = 0x39, D3 = 0x3A, D4 = 0x3B, D5 = 0x3C

const TOKENS = [
  "YOSHI'S","STAR","IGGY'S","MORTON'S","LEMMY'S","LUDWIG'S","ROY'S","WENDY'S",
  "LARRY'S","DONUT","GREEN","TOP SECRET AREA","VANILLA","RED","BLUE",
  "BUTTER BRIDGE","CHEESE BRIDGE","SODA LAKE","COOKIE MOUNTAIN","FOREST",
  "CHOCOLATE","CHOCO GHOST HOUSE","SUNKEN GHOST SHIP","VALLEY","BACK DOOR",
  "FRONT DOOR","GNARLY","TUBULAR","WAY COOL","HOUSE","ISLAND","SWITCH PALACE",
  "CASTLE","PLAINS","GHOST HOUSE","SECRET","DOME","FORTRESS","OF","ON","OF BOWSER",
  "ROAD","WORLD","AWESOME","PALAC","ARE","GROOV","MOND","OUTRAGEOU","FUNK","HOUS","BAAIANAXA"
]

function tokenName(b) {
  if (b >= 0x38 && b <= 0x3C) return `"${b - 0x37}"` // digits 1-5
  if (b === 0xFF) return 'END'
  if (b < TOKENS.length) return `"${TOKENS[b]}"`
  return `$${hex(b)}`
}

function findPattern(buf, hasHeader, pattern, label) {
  const base = hasHeader ? COPIER_HEADER : 0
  const hits = []
  outer: for (let i = base; i < buf.length - pattern.length; i++) {
    for (let j = 0; j < pattern.length; j++) {
      if (pattern[j] !== -1 && buf[i + j] !== pattern[j]) continue outer
    }
    hits.push(i)
  }
  const snesLabel = hits.length > 0 ? hits.map(h => `$${hex(toSnes(h,hasHeader),6)}`).join(', ') : 'NONE'
  console.log(`  ${label}: ${hits.length} hit(s) at ${snesLabel}`)
  for (const h of hits.slice(0, 5)) {
    const ctx = [...buf.slice(Math.max(h-4,0), h+12)].map(b => hex(b)).join(' ')
    console.log(`    file $${hex(h,6)}: ${ctx}`)
  }
  return hits
}

function dumpRegion(buf, hasHeader, label, fileStart, dumpLen) {
  console.log(`\n  --- ${label} at file $${hex(fileStart,6)} SNES $${hex(toSnes(fileStart,hasHeader),6)} ---`)
  for (let off = fileStart; off < fileStart + dumpLen && off < buf.length; off += 16) {
    const len = Math.min(16, fileStart + dumpLen - off)
    const row = buf.slice(off, off + len)
    const h = [...row].map(b => hex(b)).join(' ').padEnd(47)
    const snes = toSnes(off, hasHeader)
    const decoded = [...row].map(b => tokenName(b).slice(0,6)).join(' ')
    console.log(`  $${hex(snes,6)}  ${h}`)
    console.log(`              ${decoded}`)
  }
}

const romPath = process.argv[2]
if (!romPath) { console.error('Usage: node scripts/find-level-name-table.mjs <rom.sfc>'); process.exit(1) }
const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}\nSize: ${buf.length} | Header: ${hasHeader ? 'yes' : 'no'}\n`)

// ── 1. Search for known multi-level patterns ───────────────────────────────────
console.log('='.repeat(70))
console.log('SEARCH 1 — 3-byte entries [prefix][suffix][digit]')
console.log('='.repeat(70))

// Yoshi's Island 1,2,3,4 consecutively
findPattern(buf, hasHeader, [YOSHI_S, ISLAND, D1, YOSHI_S, ISLAND, D2],
  "YOSHI'S ISLAND 1+2 (3-byte)")
findPattern(buf, hasHeader, [YOSHI_S, ISLAND, D1, YOSHI_S, ISLAND, D2, YOSHI_S, ISLAND, D3, YOSHI_S, ISLAND, D4],
  "YOSHI'S ISLAND 1-4 (3-byte, seq IDs)")

// Donut Plains 1,2,3,4
findPattern(buf, hasHeader, [DONUT, PLAINS, D1, DONUT, PLAINS, D2],
  "DONUT PLAINS 1+2 (3-byte)")

// Vanilla Dome 1,2,3,4
findPattern(buf, hasHeader, [VANILLA, DOME, D1, VANILLA, DOME, D2],
  "VANILLA DOME 1+2 (3-byte)")

// What about 2-byte entries (no digit) for named places?
// YOSHI'S HOUSE, YOSHI'S ISLAND 1-4 might be:
// [YOSHI_S, HOUSE, ...] then [YOSHI_S, ISLAND, ...][YOSHI_S, ISLAND, ...] etc.

console.log()
console.log('='.repeat(70))
console.log('SEARCH 2 — 2-byte entries [prefix][suffix] for unique names')
console.log('='.repeat(70))

findPattern(buf, hasHeader, [YOSHI_S, HOUSE, YOSHI_S, ISLAND, YOSHI_S, ISLAND],
  "YOSHI'S HOUSE + ISLAND×2 consecutive (2-byte)")
findPattern(buf, hasHeader, [DONUT, PLAINS, DONUT, PLAINS, DONUT, GHOST_HOUSE],
  "DONUT PLAINS×2 + GHOST HOUSE consecutive (2-byte)")
findPattern(buf, hasHeader, [VANILLA, DOME, VANILLA, DOME, VANILLA, DOME],
  "VANILLA DOME×3 consecutive (2-byte)")
findPattern(buf, hasHeader, [CHOCOLATE, ISLAND, CHOCOLATE, ISLAND],
  "CHOCOLATE ISLAND×2 (2-byte, seq IDs)")
findPattern(buf, hasHeader, [VALLEY, OF_BOWSER, VALLEY, OF_BOWSER],
  "VALLEY OF BOWSER×2 (2-byte, seq IDs)")

console.log()
console.log('='.repeat(70))
console.log('SEARCH 3 — Level name area using PTR IDs (note: ptr IDs differ from seq IDs!)')
console.log('PTR  0=STAR 1=IGGY\'S 8=DONUT 11=VANILLA 23=VALLEY 30=HOUSE 31=ISLAND 33=CASTLE 34=PLAINS 40=OF BOWSER')
console.log('='.repeat(70))

// Using PTR IDs:
// ptr YOSHI'S = N/A, HOUSE=30=$1E, ISLAND=31=$1F, DONUT=8=$08, PLAINS=34=$22
// ptr VANILLA=11=$0B, DOME=37=$25, VALLEY=23=$17, OF_BOWSER=40=$28

findPattern(buf, hasHeader, [0x1E, 0x1F, 0x1F, 0x1F],
  "HOUSE ISLAND ISLAND ISLAND (ptr, might show YI1-4 vicinity)")
findPattern(buf, hasHeader, [0x08, 0x22, 0x08, 0x22],
  "DONUT PLAINS × 2 (ptr IDs)")
findPattern(buf, hasHeader, [0x0B, 0x25, 0x0B, 0x25],
  "VANILLA DOME × 2 (ptr IDs)")
findPattern(buf, hasHeader, [0x17, 0x28, 0x17, 0x28],
  "VALLEY OF BOWSER × 2 (ptr IDs)")

console.log()
console.log('='.repeat(70))
console.log('SEARCH 4 — Dump SNES $00A920 context (Vanilla Dome found there)')
console.log('='.repeat(70))
dumpRegion(buf, hasHeader, "Context around SNES $00A920", 0x002800, 0x200)

console.log()
console.log('='.repeat(70))
console.log('SEARCH 5 — Dump SNES $00B276 context (Valley of Bowser found there)')
console.log('='.repeat(70))
dumpRegion(buf, hasHeader, "Context around SNES $00B276", 0x003200, 0x100)

console.log()
console.log('='.repeat(70))
console.log('SEARCH 6 — Look for the name table as: level_slot → byte_offset into "chunks"')
console.log('  Theory: 96 entries × 1 byte = 96-byte index table, each byte is a "name chunk ID"')
console.log('  Name chunk IDs: YOSHI\'S HOUSE=0, YOSHI\'S ISLAND=1, DONUT PLAINS=2, ...')
console.log('  Search for a 96-byte array where values are all small (0-40) near other name data')
console.log('='.repeat(70))

const base = hasHeader ? COPIER_HEADER : 0
for (let off = base; off < buf.length - 96; off++) {
  let maxVal = 0
  let allSmall = true
  for (let i = 0; i < 96; i++) {
    const v = buf[off + i]
    if (v > 50) { allSmall = false; break }
    if (v > maxVal) maxVal = v
  }
  if (allSmall && maxVal >= 30 && maxVal <= 50) {
    // Check for diversity: we want many distinct values
    const unique = new Set(buf.slice(off, off + 96)).size
    if (unique >= 15) {
      const snes = toSnes(off, hasHeader)
      console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)}: 96 bytes, max=${maxVal}, unique=${unique}`)
      const preview = [...buf.slice(off, off+32)].map(b=>hex(b)).join(' ')
      console.log(`    ${preview}`)
    }
  }
}

console.log()
console.log('='.repeat(70))
console.log('SEARCH 7 — Search for runs of [$FF term] in bank $00 that could be name sequences')
console.log('='.repeat(70))
// Variable-length sequences terminated by $FF:
// Each name = [tok1][tok2]...[FF], all toks valid seq IDs (0-51)
// Find regions with many consecutive such sequences

const bankStart = base
const bankEnd   = base + 0x8000
const MAX_SEQ_ID = 51

function tryDecodeSequences(startOff, count) {
  let off = startOff
  const names = []
  for (let s = 0; s < count && off < bankEnd; s++) {
    if (buf[off] === 0xFF) { names.push({ tokens: [], term: 0xFF }); off++; continue }
    const toks = []
    while (off < bankEnd && buf[off] !== 0xFF) {
      const b = buf[off]
      if (b > MAX_SEQ_ID && !(b >= 0x38 && b <= 0x3C)) {
        return null  // invalid byte → not a sequence table
      }
      toks.push(b)
      off++
      if (toks.length > 6) return null  // name too long → probably not
    }
    if (buf[off] === 0xFF) off++  // consume terminator
    const name = toks.map(t => {
      if (t >= 0x38 && t <= 0x3C) return String(t - 0x37)
      return TOKENS[t] || `?${t}`
    }).join(' ')
    names.push({ tokens: toks, name, off: off - toks.length - 1 })
  }
  return names
}

// Scan bank $00 for regions that look like variable-length name sequences
for (let off = bankStart; off < bankEnd - 32; off++) {
  const seqs = tryDecodeSequences(off, 8)
  if (seqs && seqs.length >= 8 && seqs.filter(s => s.name && s.tokens.length > 0).length >= 6) {
    const goodNames = seqs.filter(s => s.name)
    const allMakeNameSense = goodNames.slice(0, 4).every(s =>
      s.tokens.length >= 1 && s.tokens.length <= 4
    )
    if (allMakeNameSense) {
      const snes = toSnes(off, hasHeader)
      console.log(`  Candidate at file $${hex(off,6)} SNES $${hex(snes,6)}:`)
      for (const s of seqs.slice(0, 8)) {
        console.log(`    "${s.name || '(empty)'}"`)
      }
      console.log()
    }
  }
}

console.log('Done.')
