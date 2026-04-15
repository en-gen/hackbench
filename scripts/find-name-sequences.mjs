/**
 * find-name-sequences.mjs
 *
 * APPROACH: Build the exact sequential token ID list by directly parsing
 * the token text table. Then search the ROM for byte sequences that match
 * known level name pairs using BOTH pointer-table IDs and sequential IDs.
 *
 * Also: dumps the data at SNES $009248 (file $001248) which had pointer-like
 * values, and examines the overworld level data area.
 *
 * Usage:
 *   node scripts/find-name-sequences.mjs <rom.sfc>
 */

import * as fs from 'fs'

const COPIER_HEADER  = 512
const TOKEN_TABLE_FILE = 0x021AC5  // SNES $049AC5 (unheadered)
const PTR_TABLE_FILE   = 0x021C95  // TOKEN_TABLE_FILE + $01D0

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

// ── Step 1: Parse exact token sequence from the token text table ──────────────
// Each token is a run of letter bytes (0x00-0x19), apostrophes (0x5D),
// and in-word spaces (0x1F, 0x1C followed immediately by another letter).
// Tokens are separated by 0x5A prefix bytes (or the very first starts directly).

function parseExactTokens(buf) {
  const tokens = []  // { seqId, fileOff, text }
  const base = TOKEN_TABLE_FILE
  const end = PTR_TABLE_FILE + 200  // scan well past the pointer table
  let i = base

  while (i < end && tokens.length < 100) {
    // Skip separator sequences (0x5A xx 0x1F is common)
    while (i < end && !(buf[i] >= 0x00 && buf[i] <= 0x19)) {
      i++
    }
    if (i >= end) break

    const tokenStart = i
    let text = ''

    while (i < end) {
      const b = buf[i]
      if (b >= 0x00 && b <= 0x19) {
        text += String.fromCharCode(65 + b)
        i++
      } else if (b === 0x5D) {
        text += "'"
        i++
      } else if (b === 0x1F || b === 0x1C) {
        const next = i + 1 < end ? buf[i + 1] : 0xFF
        if (next >= 0x00 && next <= 0x19) {
          text += ' '
          i++
        } else {
          i++
          break
        }
      } else {
        if (b === 0x9F) i++
        break
      }
    }

    if (text.length >= 2) {
      tokens.push({ seqId: tokens.length, fileOff: tokenStart, text })
    }
  }

  return tokens
}

// ── Step 2: Build pointer table → seqId mapping ───────────────────────────────

function buildPtrToSeq(buf, tokens) {
  const byFileOff = new Map(tokens.map(t => [t.fileOff, t]))
  const ptrToSeq = []  // ptrToSeq[ptrId] = seqId (or null)

  for (let i = 0; i < 60; i++) {
    const ptrOff = PTR_TABLE_FILE + i * 2
    if (ptrOff + 1 >= buf.length) break
    const rel = buf[ptrOff] | (buf[ptrOff + 1] << 8)
    if (rel > 0x03D0) break  // past token table region

    const targetFile = TOKEN_TABLE_FILE + rel
    const tok = byFileOff.get(targetFile)
    ptrToSeq.push({ ptrId: i, seqId: tok?.seqId ?? null, text: tok?.text ?? null })
  }

  return ptrToSeq
}

// ── Step 3: Search for known name pairs ──────────────────────────────────────

function searchPair(buf, hasHeader, a, b, label) {
  const base = hasHeader ? COPIER_HEADER : 0
  let found = []
  for (let i = base; i < buf.length - 1; i++) {
    if (buf[i] === a && buf[i + 1] === b) {
      found.push({ off: i, snes: toSnes(i, hasHeader) })
    }
  }
  if (found.length === 0) {
    console.log(`  [${hex(a)} ${hex(b)}] ${label}: NOT FOUND`)
  } else {
    console.log(`  [${hex(a)} ${hex(b)}] ${label}: ${found.length} hits`)
    for (const { off, snes } of found.slice(0, 8)) {
      const ctx = [...buf.slice(Math.max(off - 4, 0), off + 8)].map(b2 => hex(b2)).join(' ')
      console.log(`    file $${hex(off, 6)} SNES $${hex(snes, 6)}: ${ctx}`)
    }
    if (found.length > 8) console.log(`    ... ${found.length - 8} more`)
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/find-name-sequences.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}\nSize: ${buf.length} | Header: ${hasHeader ? 'yes' : 'no'}\n`)

// Step 1: Parse tokens
const tokens = parseExactTokens(buf)
console.log('='.repeat(70))
console.log(`STEP 1 — Exact token list (sequential IDs) from file $${hex(TOKEN_TABLE_FILE,6)}`)
console.log('='.repeat(70))
for (const t of tokens) {
  const relOff = t.fileOff - TOKEN_TABLE_FILE
  console.log(`  seq[${String(t.seqId).padStart(2)}]  file $${hex(t.fileOff,6)}  rel=$${hex(relOff,4)}  "${t.text}"`)
}
console.log()

// Step 2: Build ptr→seq mapping
const ptrToSeq = buildPtrToSeq(buf, tokens)
console.log('='.repeat(70))
console.log('STEP 2 — Pointer table (ptrId → seqId → text)')
console.log('='.repeat(70))
for (const { ptrId, seqId, text } of ptrToSeq) {
  if (seqId === null) {
    const ptrOff = PTR_TABLE_FILE + ptrId * 2
    const rel = buf[ptrOff] | (buf[ptrOff + 1] << 8)
    console.log(`  ptr[${String(ptrId).padStart(2)}]  rel=$${hex(rel,4)}  → seq[?]  (no match)`)
  } else {
    console.log(`  ptr[${String(ptrId).padStart(2)}]  → seq[${String(seqId).padStart(2)}]  "${text}"`)
  }
}
console.log()

// Step 3: Build lookup helpers
const seqByText = new Map(tokens.map(t => [t.text, t.seqId]))
const ptrByText = new Map(ptrToSeq.filter(p => p.text).map(p => [p.text, p.ptrId]))

function ids(text) {
  const s = seqByText.get(text) ?? '?'
  const p = ptrByText.get(text) ?? '?'
  return `seq=${s} ptr=${p}`
}

console.log('='.repeat(70))
console.log('STEP 3 — Key token IDs')
console.log('='.repeat(70))
const keyTokens = ["YOSHI'S", 'STAR', "IGGY'S", 'DONUT', 'VANILLA', 'FOREST',
                   'CHOCOLATE', 'VALLEY', 'HOUSE', 'ISLAND', 'CASTLE', 'PLAINS',
                   'GHOST HOUSE', 'DOME', 'FORTRESS', 'OF BOWSER', 'WORLD',
                   'SWITCH PALACE', 'SECRET', 'GNARLY', 'TUBULAR', 'WAY COOL',
                   'AWESOME', 'BACK DOOR', 'FRONT DOOR']
for (const text of keyTokens) {
  console.log(`  "${text}": ${ids(text)}`)
}
console.log()

// Step 4: Search for known name pairs using BOTH id systems
console.log('='.repeat(70))
console.log('STEP 4 — Search for known level name pairs (seq IDs)')
console.log('='.repeat(70))

const knownPairs = [
  ["YOSHI'S", 'HOUSE'],
  ["YOSHI'S", 'ISLAND'],
  ['DONUT', 'PLAINS'],
  ['DONUT', 'GHOST HOUSE'],
  ['DONUT', 'SECRET HOUSE'],
  ['VANILLA', 'DOME'],
  ['VANILLA', 'GHOST HOUSE'],
  ['VANILLA', 'FORTRESS'],
  ['FOREST', 'OF ILLUSION'],
  ['CHOCOLATE', 'ISLAND'],
  ['VALLEY', 'OF BOWSER'],
  ['STAR', 'WORLD'],
  ['GNARLY', ''],  // just search for GNARLY
]

for (const [a, b] of knownPairs) {
  const seqA = seqByText.get(a)
  const seqB = b ? seqByText.get(b) : null
  if (seqA === undefined) {
    console.log(`  "${a}": not found in seq table`)
    continue
  }
  if (b && seqB === undefined) {
    console.log(`  "${a} ${b}": "${b}" not found in seq table`)
    continue
  }
  if (!b) {
    searchPair(buf, hasHeader, seqA, -1, `"${a}" (seq=${seqA} alone)`)
    continue
  }
  console.log(`  --- "${a} ${b}" [seq: ${hex(seqA)} ${hex(seqB)}] ---`)
  searchPair(buf, hasHeader, seqA, seqB, `(seq IDs)`)
}
console.log()

// Also search using pointer IDs
console.log('='.repeat(70))
console.log('STEP 5 — Search for known level name pairs (ptr IDs)')
console.log('='.repeat(70))

const knownPairs2 = [
  ['DONUT', 'PLAINS'],
  ['DONUT', 'GHOST HOUSE'],
  ['VANILLA', 'DOME'],
  ['VALLEY', 'OF BOWSER'],
  ['STAR', 'WORLD'],
  ['CHOCOLATE', 'ISLAND'],
]
for (const [a, b] of knownPairs2) {
  const pA = ptrByText.get(a)
  const pB = ptrByText.get(b)
  if (pA === undefined || pB === undefined) {
    console.log(`  "${a} ${b}": ptr not found (pA=${pA} pB=${pB})`)
    continue
  }
  console.log(`  --- "${a} ${b}" [ptr: ${hex(pA)} ${hex(pB)}] ---`)
  searchPair(buf, hasHeader, pA, pB, `(ptr IDs)`)
}
console.log()

// Step 6: Dump the region at SNES $009248 (file $001248) that had 4 ptr-like values
console.log('='.repeat(70))
console.log('STEP 6 — Dump SNES $009248 (file $001248) region')
console.log('='.repeat(70))
const dump1248Start = 0x001248 - 16
const dump1248End   = 0x001248 + 64
for (let off = dump1248Start; off < dump1248End; off += 16) {
  const len = Math.min(16, dump1248End - off)
  const row = buf.slice(off, off + len)
  const h = [...row].map(b => hex(b)).join(' ').padEnd(47)
  const a = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
  const snes = toSnes(off, hasHeader)
  const marker = (off >= 0x001248 && off < 0x001258) ? '>' : ' '
  console.log(` ${marker}$${hex(snes,6)}  ${h}  |${a}|`)
}
console.log()

// Step 7: Look at every place that has an entry for the token table area
// by finding all 2-byte values in [0x0000, 0x03D0] at ODD file offsets too
console.log('='.repeat(70))
console.log('STEP 7 — Search (no alignment) for 4+ consecutive ptr values → token table')
console.log('='.repeat(70))

const TOK_END_REL = PTR_TABLE_FILE - TOKEN_TABLE_FILE + 0x100  // $03D0 + buffer

function isInTokRange(v) { return v > 0 && v <= TOK_END_REL }

const base = hasHeader ? COPIER_HEADER : 0
let hits = []

for (let off = base; off < buf.length - 1; off++) {
  let run = 0
  let tmpOff = off
  // Try to read 2-byte LE values at various alignments
  while (tmpOff + 1 < buf.length) {
    const v = buf[tmpOff] | (buf[tmpOff + 1] << 8)
    if (isInTokRange(v)) { run++; tmpOff += 2 }
    else break
  }
  if (run >= 4) {
    const snes = toSnes(off, hasHeader)
    console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)} — ${run} consecutive LE16 ptrs into token table:`)
    for (let r = 0; r < Math.min(run, 12); r++) {
      const o = off + r * 2
      const v = buf[o] | (buf[o+1] << 8)
      const tgt = TOKEN_TABLE_FILE + v
      const relDesc = `tok+$${hex(v,4)}`
      // Find which token that offset corresponds to
      const tok = tokens.find(t => t.fileOff === tgt)
      const tokName = tok ? `"${tok.text}"` : `(between tokens)`
      console.log(`    [${String(r).padStart(2)}]  $${hex(v,4)} → ${relDesc} ${tokName}`)
    }
    if (run > 12) console.log(`    ... ${run-12} more`)
    off = tmpOff - 2  // skip past this run (loop will +1)
    console.log()
    hits.push(off)
  }
}

if (hits.length === 0) console.log('  (none found)')
console.log('\nDone.')
