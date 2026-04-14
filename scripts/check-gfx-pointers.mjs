/**
 * Diagnostic script: check GFX file pointer tables in a vanilla SMW ROM.
 *
 * Usage:
 *   node scripts/check-gfx-pointers.mjs <path-to-rom.sfc>
 *
 * Prints the SNES address computed for each of the 52 GFX files using the
 * current lo/hi/bank table addresses, then shows the first 4 raw bytes at
 * each address so you can see whether the pointers land on valid data.
 */

import { readFileSync } from 'fs'

// ── Args ──────────────────────────────────────────────────────────────────────
const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node check-gfx-pointers.mjs <path-to-rom.sfc>')
  process.exit(1)
}

const raw = readFileSync(romPath)

// ── SMC header detection ──────────────────────────────────────────────────────
const hasHeader = (raw.length % 1024) === 512
const hdrOff    = hasHeader ? 512 : 0
console.log(`ROM: ${raw.length} bytes, SMC header: ${hasHeader}`)

// ── LoROM address → file offset ───────────────────────────────────────────────
function loromToOffset(snesAddr) {
  const bank        = (snesAddr >>> 16) & 0xFF
  const addr        = snesAddr & 0xFFFF
  const effectiveBank = bank & 0x7F
  if (effectiveBank > 0x3F) return null
  if (addr < 0x8000) return null
  return hdrOff + effectiveBank * 0x8000 + (addr - 0x8000)
}

function readByte(snesAddr) {
  const off = loromToOffset(snesAddr)
  if (off === null || off >= raw.length) return null
  return raw[off]
}

function readAt(snesAddr, len) {
  const off = loromToOffset(snesAddr)
  if (off === null || off + len > raw.length) return null
  return raw.subarray(off, off + len)
}

// ── LC_LZ2 first-command heuristic ────────────────────────────────────────────
// A valid LC_LZ2 stream starts with a command byte.  Command 0xFF = terminator
// (empty), anything else is a valid (if odd) start. We just print the first 4
// raw bytes so you can spot obviously wrong (all-zeros, all-FF, code-like) data.
function firstBytes(snesAddr) {
  const buf = readAt(snesAddr, 4)
  if (!buf) return '(no data)'
  return Array.from(buf).map(b => b.toString(16).padStart(2, '0')).join(' ')
}

// ── Try several candidate table base addresses ─────────────────────────────────
// We suspect $B992/$B9C4/$B9F6 but spacing $32=50 doesn't cover 52 files.
// Also try $B992/$B9C6/$B9FA (spacing $34=52).
const CANDIDATES = [
  { label: 'current  (spacing=$32=50)', lo: 0x00B992, hi: 0x00B9C4, bk: 0x00B9F6 },
  { label: 'adjusted (spacing=$34=52)', lo: 0x00B992, hi: 0x00B9C6, bk: 0x00B9FA },
]

const GFX_FILE_COUNT = 52

for (const { label, lo: LO, hi: HI, bk: BK } of CANDIDATES) {
  console.log(`\n════════════════════════════════════════════════`)
  console.log(`Table set: ${label}`)
  console.log(`  LO=$${LO.toString(16).toUpperCase()}  HI=$${HI.toString(16).toUpperCase()}  BK=$${BK.toString(16).toUpperCase()}`)
  console.log(`  (file offsets: LO=$${loromToOffset(LO)?.toString(16)} HI=$${loromToOffset(HI)?.toString(16)} BK=$${loromToOffset(BK)?.toString(16)})`)
  console.log()
  console.log('Idx  HEX  LO   HI   BK   → SNES Addr    first 4 bytes')
  console.log('─'.repeat(64))

  let validCount = 0
  for (let i = 0; i < GFX_FILE_COUNT; i++) {
    const loB  = readByte(LO + i)
    const hiB  = readByte(HI + i)
    const bkB  = readByte(BK + i)
    if (loB === null || hiB === null || bkB === null) {
      console.log(`${String(i).padStart(3)}  ${i.toString(16).toUpperCase().padStart(2,'0')}   --   --   --   → (out of range)`)
      continue
    }
    const snes = (bkB << 16) | (hiB << 8) | loB
    const hex  = i.toString(16).toUpperCase().padStart(2, '0')
    const bytes = firstBytes(snes)
    // Heuristic: bank $08-$0B is expected for compressed GFX data
    const bankOk = bkB >= 0x08 && bkB <= 0x0B
    const mark   = bankOk ? '' : ' ← BAD BANK'
    if (bankOk) validCount++
    console.log(
      `${String(i).padStart(3)}  ${hex}   ${loB.toString(16).padStart(2,'0')}   ${hiB.toString(16).padStart(2,'0')}   ${bkB.toString(16).padStart(2,'0')}   → $${snes.toString(16).toUpperCase().padStart(6,'0')}    ${bytes}${mark}`
    )
  }
  console.log(`\n  → ${validCount}/${GFX_FILE_COUNT} entries have bank in $08–$0B`)
}

// ── Extra: dump raw bytes around each table start ─────────────────────────────
console.log('\n════════════════════════════════════════════════')
console.log('Raw ROM bytes around $00B990 (±2):')
const dumpStart = 0x00B990
const dumpBuf = readAt(dumpStart, 0x80)
if (dumpBuf) {
  for (let row = 0; row < dumpBuf.length; row += 16) {
    const addr = dumpStart + row
    const hex  = Array.from(dumpBuf.subarray(row, row + 16))
      .map(b => b.toString(16).padStart(2, '0')).join(' ')
    console.log(`$${addr.toString(16).toUpperCase().padStart(6,'0')}:  ${hex}`)
  }
}
