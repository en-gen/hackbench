/**
 * dump-name-table.mjs
 *
 * Focused dump of the level name region found at file $021CC5 (SNES ~$049AC5),
 * plus the bank $07 $F000–$FFFF region suggested by hacking docs.
 *
 * Tile encoding confirmed by Strategy 1:  A=$00, B=$01, …, Z=$19
 * (i.e. the letter index is the tile byte directly, 0-based)
 * Special chars and terminators are reported as hex.
 *
 * Usage:
 *   node scripts/dump-name-table.mjs <rom.sfc>
 */

import * as fs from 'fs'

const COPIER_HEADER = 512

function loadRom(path) {
  const buf = fs.readFileSync(path)
  const hasHeader = (buf.length % 1024) === COPIER_HEADER
  return { buf, hasHeader }
}

function hex(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, '0') }

function loromToOffset(snes, hasHeader) {
  const bank = (snes >>> 16) & 0x7F
  const addr = snes & 0xFFFF
  if (addr < 0x8000) return null
  const off = bank * 0x8000 + (addr - 0x8000) + (hasHeader ? COPIER_HEADER : 0)
  return off
}

// Confirmed tile encoding: byte value = letter index (A=0x00, B=0x01, ... Z=0x19)
const TILE_A_BASE = 0x00
function decodeChar(b) {
  const idx = b - TILE_A_BASE
  if (idx >= 0 && idx < 26) return String.fromCharCode(65 + idx)
  if (b >= 0x1A && b <= 0x23) return String(b - 0x1A)  // try digits: guess
  return null
}

function decodeName(buf, off, maxLen = 48) {
  const chars = []
  for (let i = 0; i < maxLen && off + i < buf.length; i++) {
    const b = buf[off + i]
    const c = decodeChar(b)
    if (c !== null) {
      chars.push(c)
    } else {
      chars.push(`[${hex(b)}]`)
    }
  }
  return chars.join('')
}

// ── Region 1: around the hit at file $021CC5 ─────────────────────────────────

function dumpRegion(buf, hasHeader, label, fileStart, length) {
  console.log('='.repeat(70))
  console.log(label)
  console.log('='.repeat(70))

  const end = Math.min(fileStart + length, buf.length)

  // Raw hex dump (16 bytes per row)
  console.log('\n  Raw hex dump:')
  for (let off = fileStart; off < end; off += 16) {
    const row = buf.slice(off, Math.min(off + 16, end))
    const h = [...row].map(b => hex(b)).join(' ')
    const a = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
    const tileDecoded = [...row].map(b => {
      const c = decodeChar(b)
      return c !== null ? c : '.'
    }).join('')
    console.log(`  $${hex(off,6)}  ${h.padEnd(47)}  |${a}|  tile:|${tileDecoded}|`)
  }

  // Try to parse as a name table: look for runs of decodable chars separated
  // by non-letter bytes, and print each run.
  console.log('\n  Decoded name runs (consecutive decodable tile bytes):')
  let runStart = -1
  for (let off = fileStart; off <= end; off++) {
    const atEnd = off === end
    const c = !atEnd ? decodeChar(buf[off]) : null

    if (c !== null && runStart < 0) {
      runStart = off
    } else if ((c === null || atEnd) && runStart >= 0) {
      const runLen = off - runStart
      if (runLen >= 3) {
        const name = decodeName(buf, runStart, runLen)
        const terminatorByte = !atEnd ? hex(buf[off]) : 'EOF'
        console.log(`    $${hex(runStart,6)}  len=${runLen}  "${name}"  (term=$${terminatorByte})`)
      }
      runStart = -1
    }
  }
  console.log()
}

// ── Entry point ───────────────────────────────────────────────────────────────

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/dump-name-table.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}`)
console.log(`Size: ${buf.length} bytes  |  Header: ${hasHeader ? 'yes' : 'no'}\n`)
console.log(`Tile encoding: A=$00 B=$01 … Z=$${hex(25)} (0-based letter index)\n`)

// Region found by Strategy 1 — start 64 bytes before the hit, show 512 bytes
dumpRegion(buf, hasHeader,
  'REGION 1 — Hit at file $021CC5 (SNES ~$049AC5, bank $04)',
  0x021CC5 - 0x40,  // back up a bit to see context
  0x300)

// Bank $07 $F000–$FFFF as suggested by hacking docs
const bank07F000 = loromToOffset(0x07F000, hasHeader)
if (bank07F000 !== null && bank07F000 < buf.length) {
  dumpRegion(buf, hasHeader,
    'REGION 2 — Bank $07 $F000–$FFFF (hacking doc suggestion)',
    bank07F000,
    0x1000)
}

// Also try the area just before $021CC5 to see if there's a pointer table
console.log('='.repeat(70))
console.log('POINTER TABLE SCAN — 256 bytes before hit, looking for 2-byte pointers')
console.log('='.repeat(70))
const preHit = buf.slice(0x021A00, 0x021CC5)
console.log('Bytes $021A00–$021CC4:')
for (let i = 0; i < preHit.length; i += 16) {
  const row = preHit.slice(i, i + 16)
  const h = [...row].map(b => hex(b)).join(' ')
  const a = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
  console.log(`  $${hex(0x021A00 + i, 6)}  ${h.padEnd(47)}  |${a}|`)
}
