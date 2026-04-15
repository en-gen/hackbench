/**
 * dump-composition-table.mjs
 *
 * Dumps the 2-byte composition table candidates found at:
 *   $006ACD (SNES $00E8CD) — alternating [prefix][suffix] pattern
 *   $02239A (SNES $04A19A) — YOSHI'S HOUSE + YOSHI'S ISLAND adjacent
 *
 * Each 2-byte entry is [prefix_token_id, suffix_token_id].
 * Decoded against the 52-token table from decode-level-names.mjs.
 *
 * Usage:
 *   node scripts/dump-composition-table.mjs <rom.sfc>
 */

import * as fs from 'fs'

const COPIER_HEADER = 512

function loadRom(path) {
  const buf = fs.readFileSync(path)
  const hasHeader = (buf.length % 1024) === COPIER_HEADER
  return { buf, hasHeader }
}

function hex(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, '0') }

function offsetToSnes(fileOff, hasHeader) {
  const off = fileOff - (hasHeader ? COPIER_HEADER : 0)
  const bank = Math.floor(off / 0x8000)
  const addr = 0x8000 + (off % 0x8000)
  return (bank << 16) | addr
}

// Confirmed 52-token list (from decode-level-names output)
const TOKENS = [
  "YOSHI'S", "STAR", "IGGY'S", "MORTON'S", "LEMMY'S", "LUDWIG'S",
  "ROY'S", "WENDY'S", "LARRY'S", "DONUT", "GREEN", "TOP SECRET AREA",
  "VANILLA", "RED", "BLUE", "BUTTER BRIDGE", "CHEESE BRIDGE", "SODA LAKE",
  "COOKIE MOUNTAIN", "FOREST", "CHOCOLATE", "CHOCO GHOST HOUSE",
  "SUNKEN GHOST SHIP", "VALLEY", "BACK DOOR", "FRONT DOOR", "GNARLY",
  "TUBULAR", "WAY COOL", "HOUSE", "ISLAND", "SWITCH PALACE", "CASTLE",
  "PLAINS", "GHOST HOUSE", "SECRET", "DOME", "FORTRESS", "OF", "ON",
  "OF BOWSER", "ROAD", "WORLD", "AWESOME", "PALAC", "ARE", "GROOV",
  "MOND", "OUTRAGEOU", "FUNK", "HOUS", "BAAIANAXA"
]

function tokenName(id) {
  return id < TOKENS.length ? TOKENS[id] : `?($${hex(id)})`
}

function dumpRegion(buf, hasHeader, label, fileStart, dumpLen, entryLen) {
  console.log('='.repeat(70))
  console.log(`${label}`)
  console.log(`  file $${hex(fileStart,6)}  SNES ~$${hex(offsetToSnes(fileStart,hasHeader),6)}`)
  console.log('='.repeat(70))

  // Raw hex dump first (64 bytes before + dumpLen)
  const showFrom = Math.max(0, fileStart - 32)
  const showTo   = Math.min(buf.length, fileStart + dumpLen + 32)
  console.log('\n  Raw hex (context +/- 32 bytes):')
  for (let off = showFrom; off < showTo; off += 16) {
    const marker = (off >= fileStart && off < fileStart + dumpLen) ? '>' : ' '
    const row = buf.slice(off, Math.min(off + 16, showTo))
    const h = [...row].map(b => hex(b)).join(' ')
    const a = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
    console.log(`  ${marker} $${hex(off,6)}  ${h.padEnd(47)}  |${a}|`)
  }

  // Decode as composition entries
  console.log(`\n  Decoded as ${entryLen}-byte entries [prefix][suffix]:`)
  for (let off = fileStart; off < fileStart + dumpLen && off + entryLen <= buf.length; off += entryLen) {
    const bytes = [...buf.slice(off, off + entryLen)]
    const bytesHex = bytes.map(b => hex(b)).join(' ')
    if (entryLen === 2) {
      const name = `${tokenName(bytes[0])} ${tokenName(bytes[1])}`
      console.log(`  $${hex(off,6)}  [${bytesHex}]  →  "${name}"`)
    } else if (entryLen === 3) {
      const name = `${tokenName(bytes[0])} ${tokenName(bytes[1])} ${tokenName(bytes[2])}`
      console.log(`  $${hex(off,6)}  [${bytesHex}]  →  "${name}"`)
    }
  }
  console.log()
}

// ── Also search the entire bank $00 for composition tables ────────────────────
// Bank $00 is where $006ACD lives. The overworld name display code is likely
// in bank $00 or $04. Search for any run of 96+ bytes that look like
// 2-byte composition entries.

function searchBank00(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('Bank $00 — comprehensive scan for 2-byte composition pairs')
  console.log('='.repeat(70))

  const base = hasHeader ? COPIER_HEADER : 0
  const bankEnd = base + 0x8000  // bank $00 = file $00000–$07FFF (+header)

  // A "composition pair" is any 2-byte sequence [a][b] where both a and b
  // are valid token IDs (0–51). Look for runs of 8+ such consecutive pairs.
  const maxId = TOKENS.length - 1

  for (let off = base; off < bankEnd - 16; off += 2) {
    let pairs = 0
    while (off + pairs*2 + 1 < bankEnd) {
      const a = buf[off + pairs*2]
      const b = buf[off + pairs*2 + 1]
      if (a <= maxId && b <= maxId) pairs++
      else break
    }
    if (pairs >= 8) {
      const snes = offsetToSnes(off, hasHeader)
      console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)} — ${pairs} consecutive valid pairs`)
      for (let p = 0; p < Math.min(pairs, 20); p++) {
        const a = buf[off + p*2]
        const b = buf[off + p*2 + 1]
        const name = `${tokenName(a)} ${tokenName(b)}`
        console.log(`    [${p.toString().padStart(2)}]  [${hex(a)} ${hex(b)}]  "${name}"`)
      }
      if (pairs > 20) console.log(`    ... ${pairs - 20} more pairs ...`)
      off += pairs * 2 - 2  // skip past, loop will add 2
      console.log()
    }
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/dump-composition-table.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}\n`)

// Hit 1: $006ACD — alternating [YOSHI'S][suffix] pattern, 128 bytes
dumpRegion(buf, hasHeader, 'CANDIDATE 1  $006ACD (SNES $00E8CD)', 0x006ACD, 128, 2)

// Hit 2: $02239A — YOSHI'S HOUSE + YOSHI'S ISLAND adjacent, 64 bytes
dumpRegion(buf, hasHeader, 'CANDIDATE 2  $02239A (SNES $04A19A)', 0x02239A, 128, 2)

// Comprehensive bank $00 scan
searchBank00(buf, hasHeader)

console.log('Done.')
