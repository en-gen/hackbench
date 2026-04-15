/**
 * trace-render-name.mjs
 *
 * Traces the JSL $028752 call path that renders the level name,
 * and looks for the composition table (name_id → token sequence).
 *
 * Key findings so far:
 *   - $00EC7B: LDA $E90A,Y (tile→name_id), TSB $77, AND#3 → Y, LDA $1693 → A
 *   - $00EC86: JSL $00F127 (name display dispatcher)
 *   - $00F127: dispatches by tile_id range; for normal tiles → $00F17F path
 *   - $00F1F1: JSL $028752 (actual name renderer, bank $02)
 *
 * This script:
 *   1. Disassembles JSL $028752 and follows it
 *   2. Dumps the tables at $00F0EC, $00F0C8, $00F05C, $00F080, $00F100 (name rendering tables)
 *   3. Scans bank $04 (where token data lives) for 16-bit pointer arrays
 *      that might point to composition sequences
 *   4. Dumps the region around SNES $04A19A (prev candidate) in bank $04
 *
 * Usage:
 *   node scripts/trace-render-name.mjs <rom.sfc>
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
function fileOff(snes, hasHeader) {
  const bank = (snes >>> 16) & 0x7F
  const addr = snes & 0xFFFF
  if (addr < 0x8000) return addr + (hasHeader ? COPIER_HEADER : 0)
  return bank * 0x8000 + (addr - 0x8000) + (hasHeader ? COPIER_HEADER : 0)
}

const TOKENS = [
  /*  0 */ 'STAR',       /*  1 */ "IGGY'S",   /*  2 */ "MORTON'S",
  /*  3 */ "LEMMY'S",   /*  4 */ "LUDWIG'S",  /*  5 */ "ROY'S",
  /*  6 */ "WENDY'S",   /*  7 */ "LARRY'S",   /*  8 */ 'DONUT',
  /*  9 */ 'GREEN',     /* 10 */ 'TOP SECRET AREA', /* 11 */ 'VANILLA',
  /* 12 */ '#',         /* 13 */ 'RED',        /* 14 */ 'BLUE',
  /* 15 */ 'BUTTER BRIDGE', /* 16 */ 'CHEESE BRIDGE', /* 17 */ 'SODA LAKE',
  /* 18 */ 'COOKIE MOUNTAIN', /* 19 */ 'FOREST', /* 20 */ 'CHOCOLATE',
  /* 21 */ 'CHOCO GHOST HOUSE', /* 22 */ 'SUNKEN GHOST SHIP',
  /* 23 */ 'VALLEY',   /* 24 */ 'BACK DOOR',  /* 25 */ 'FRONT DOOR',
  /* 26 */ 'GNARLY',   /* 27 */ 'TUBULAR',    /* 28 */ 'WAY COOL',
  /* 29 */ null,        /* 30 */ 'HOUSE',      /* 31 */ 'ISLAND',
  /* 32 */ 'SWITCH PALACE', /* 33 */ 'CASTLE', /* 34 */ 'PLAINS',
  /* 35 */ 'GHOST HOUSE', /* 36 */ 'SECRET',  /* 37 */ 'DOME',
  /* 38 */ 'FORTRESS', /* 39 */ 'OF',          /* 40 */ 'OF BOWSER',
  /* 41 */ 'ROAD',     /* 42 */ 'WORLD',       /* 43 */ 'AWESOME',
  /* 44 */ null,        /* 45 */ 'PALAC',      /* 46 */ 'ARE',
  /* 47 */ 'GROOV',    /* 48 */ 'MOND',        /* 49 */ 'OUTRAGEOU',
  /* 50 */ 'FUNK',     /* 51 */ 'HOUS',
]

function hexRow(buf, off, len) {
  const row = buf.slice(off, off + len)
  return [...row].map(b => hex(b)).join(' ')
}

function rawDump(buf, hasHeader, label, startSnes, dumpLen) {
  const start = fileOff(startSnes, hasHeader)
  console.log('='.repeat(70))
  console.log(`${label}`)
  console.log(`  SNES $${hex(startSnes,6)}  file $${hex(start,6)}  (${dumpLen} bytes)`)
  console.log('='.repeat(70))
  for (let off = start; off < start + dumpLen; off += 16) {
    const len = Math.min(16, start + dumpLen - off)
    const row = buf.slice(off, off + len)
    const h = [...row].map(b => hex(b)).join(' ').padEnd(47)
    const a = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
    const snes = toSnes(off, hasHeader)
    console.log(`  $${hex(snes,6)}  ${h}  |${a}|`)
  }
  console.log()
}

// ── Step 1: Dump JSL $028752 routine ─────────────────────────────────────────
const romPath = process.argv[2]
if (!romPath) { console.error('Usage: node scripts/trace-render-name.mjs <rom.sfc>'); process.exit(1) }
const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}\nSize: ${buf.length} | Header: ${hasHeader ? 'yes' : 'no'}\n`)

rawDump(buf, hasHeader, 'JSL $028752 — name renderer (bank $02)', 0x028752, 256)

// ── Step 2: Dump the name rendering tables in bank $00 ────────────────────────
rawDump(buf, hasHeader, '$00F05C — name table (4 entries × ?)', 0x00F05C, 32)
rawDump(buf, hasHeader, '$00F080 — name table (4 entries × ?)', 0x00F080, 32)
rawDump(buf, hasHeader, '$00F0A4 — name table (4 entries × ?)', 0x00F0A4, 32)
rawDump(buf, hasHeader, '$00F0C8 — name table (4 entries × ?)', 0x00F0C8, 32)
rawDump(buf, hasHeader, '$00F0EC — name table (4 entries × ?)', 0x00F0EC, 32)
rawDump(buf, hasHeader, '$00F100 — name table', 0x00F100, 32)

// ── Step 3: Dump bank $04 around $04A19A ─────────────────────────────────────
rawDump(buf, hasHeader, '$04A19A region — prev candidate (bank $04)', 0x04A000, 512)

// ── Step 4: Search bank $04 for 16-bit pointer table pointing into token table ─
// Token table is at file $021AC5 (SNES $049AC5).
// A composition pointer table might store 16-bit offsets relative to $049AC5
// or absolute SNES addresses.

console.log('='.repeat(70))
console.log('STEP 4 — Search bank $04 for 16-bit LE pointers → bank $04 addresses')
console.log('='.repeat(70))

const bank04Start = fileOff(0x048000, hasHeader)
const bank04End   = fileOff(0x050000, hasHeader)

// Look for arrays of 16-bit values that all point into the token table area ($9AC5–$9E95)
const TOKEN_TABLE_SNES_LO = 0x9AC5
const PTR_TABLE_SNES_LO   = 0x9C95
const BANK04_LO           = 0x8000

let runStart = -1
let runCount = 0

function flushRun(runEnd) {
  if (runCount >= 4) {
    const snes = toSnes(runStart, hasHeader)
    console.log(`  file $${hex(runStart,6)} SNES $${hex(snes,6)}: ${runCount} consecutive 16-bit ptrs → bank$04`)
    for (let off = runStart; off < runEnd; off += 2) {
      const val = buf[off] | (buf[off+1] << 8)
      const absAddr = 0x040000 | val  // treat as bank $04 pointer
      const fOff = fileOff(absAddr, hasHeader)
      // Show what token starts at that location
      let tokenId = '?'
      for (let i = 0; i < TOKENS.length; i++) {
        const tOff = fileOff(0x049AC5 + (i * 8), hasHeader)  // rough estimate
        if (Math.abs(fOff - tOff) < 200) { tokenId = i; break }
      }
      console.log(`    [$${hex((off - runStart)/2)}]  $${hex(val,4)}  → SNES $${hex(0x040000|val,6)}  file $${hex(fOff,6)}`)
    }
    console.log()
  }
  runStart = -1
  runCount = 0
}

for (let off = bank04Start; off < bank04End - 1; off += 2) {
  const val = buf[off] | (buf[off + 1] << 8)
  // Check if this 16-bit value looks like a pointer into the token table region
  if (val >= TOKEN_TABLE_SNES_LO && val <= PTR_TABLE_SNES_LO + 0x200) {
    if (runStart < 0) runStart = off
    runCount++
  } else {
    if (runCount >= 4) flushRun(off)
    else { runStart = -1; runCount = 0 }
  }
}
if (runCount >= 4) flushRun(bank04End)

// ── Step 5: Search ENTIRE ROM for 16-bit LE arrays where each value points ───
// into the token text area ($021AC5–$021E95 in file offsets, or equiv. SNES)
// This finds any pointer table that indexes into the token text.

console.log('='.repeat(70))
console.log('STEP 5 — Search entire ROM for 16-bit arrays → token-text region')
console.log('='.repeat(70))

const TOKEN_FILE_START = 0x021AC5
const TOKEN_FILE_END   = 0x021E95
const base = hasHeader ? COPIER_HEADER : 0

// Also check relative offsets from TOKEN_FILE_START
const REL_MIN = 0x0000
const REL_MAX = TOKEN_FILE_END - TOKEN_FILE_START  // ~$3D0

function isRelPtr(val) { return val >= REL_MIN && val <= REL_MAX }

let relRunStart = -1
let relRunCount = 0

function flushRelRun(end) {
  if (relRunCount >= 4) {
    const snes = toSnes(relRunStart, hasHeader)
    console.log(`  file $${hex(relRunStart,6)} SNES $${hex(snes,6)}: ${relRunCount} LE16 values in range [$${hex(REL_MIN,4)}–$${hex(REL_MAX,4)}]`)
    for (let off = relRunStart; off < end; off += 2) {
      const val = buf[off] | (buf[off+1] << 8)
      const target = TOKEN_FILE_START + val
      console.log(`    ptr $${hex(val,4)} → file $${hex(target,6)}`)
    }
    console.log()
  }
  relRunStart = -1
  relRunCount = 0
}

for (let off = base; off < buf.length - 1; off += 2) {
  const val = buf[off] | (buf[off + 1] << 8)
  if (isRelPtr(val) && val !== 0) {
    if (relRunStart < 0) relRunStart = off
    relRunCount++
  } else {
    if (relRunCount >= 4) flushRelRun(off)
    else { relRunStart = -1; relRunCount = 0 }
  }
}
if (relRunCount >= 4) flushRelRun(buf.length)

console.log('\nDone.')
