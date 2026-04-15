/**
 * decode-level-names.mjs
 *
 * Parses the SMW word-token table at file $021CC5, builds a clean token list,
 * interprets the pointer table at $021E95, then searches for the composition
 * table that maps each translevel slot to a sequence of token IDs.
 *
 * Confirmed tile encoding (A=$00, B=$01 … Z=$19):
 *   $5D = apostrophe '   $9F = separator / space   $1F $1C = spaces
 *
 * Usage:
 *   node scripts/decode-level-names.mjs <rom.sfc>
 */

import * as fs from 'fs'

const COPIER_HEADER = 512
const TOKEN_TABLE_FILE   = 0x021CC5   // confirmed hit
const POINTER_TABLE_FILE = 0x021E95   // observed after name data ends
const POINTER_TABLE_COUNT = 60        // estimate; adjust as needed

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

function loromToOffset(snes, hasHeader) {
  const bank = (snes >>> 16) & 0x7F
  const addr = snes & 0xFFFF
  if (addr < 0x8000) return null
  return bank * 0x8000 + (addr - 0x8000) + (hasHeader ? COPIER_HEADER : 0)
}

// ── Token parser ──────────────────────────────────────────────────────────────
// Scan forward from TOKEN_TABLE_FILE. Collect runs of letter/apostrophe/
// embedded-space bytes. Non-letter bytes are always skipped — no special
// cases that could loop.

function parseTokens(buf, startOff, scanLen) {
  const tokens = []     // { id, fileOff, text, termByte }
  const endOff = startOff + scanLen
  let i = startOff

  while (i < endOff) {
    // Skip until we hit a letter byte (0x00–0x19)
    while (i < endOff && !(buf[i] >= 0x00 && buf[i] <= 0x19)) i++
    if (i >= endOff) break

    // Collect a token: letters, apostrophes, and embedded spaces that are
    // immediately followed by another letter
    const tokenStart = i
    let text = ''

    while (i < endOff) {
      const b = buf[i]
      if (b >= 0x00 && b <= 0x19) {
        // Letter
        text += String.fromCharCode(65 + b)
        i++
      } else if (b === 0x5D) {
        // Apostrophe — always part of the token (e.g. YOSHI'S)
        text += "'"
        i++
      } else if (b === 0x1F || b === 0x1C) {
        // In-word space (e.g. "BUTTER BRIDGE", "GHOST HOUSE") — only include
        // if immediately followed by another letter
        const next = i + 1 < endOff ? buf[i + 1] : 0xFF
        if (next >= 0x00 && next <= 0x19) {
          text += ' '
          i++
        } else {
          i++   // consume and stop
          break
        }
      } else {
        // 0x9F = token terminator; anything else = separator/code — stop, skip
        if (b === 0x9F) i++
        break
      }
    }

    const termByte = i < buf.length ? buf[i - 1] : 0xFF
    if (text.length >= 2) {
      tokens.push({ id: tokens.length, fileOff: tokenStart, text })
    }
  }

  return tokens
}

// ── Step 1: Print token table ─────────────────────────────────────────────────

function step1Tokens(buf, hasHeader) {
  const tokens = parseTokens(buf, TOKEN_TABLE_FILE, 0x200)

  console.log('='.repeat(70))
  console.log(`STEP 1 — Token table at file $${hex(TOKEN_TABLE_FILE,6)}`)
  console.log(`         SNES ~$${hex(offsetToSnes(TOKEN_TABLE_FILE,hasHeader),6)}`)
  console.log('='.repeat(70))

  for (const t of tokens) {
    console.log(`  [${String(t.id).padStart(2)}]  $${hex(t.fileOff,6)}  "${t.text}"`)
  }
  console.log(`\n  ${tokens.length} tokens total.\n`)
  return tokens
}

// ── Step 2: Interpret pointer table ──────────────────────────────────────────

function step2PointerTable(buf, hasHeader, tokens) {
  console.log('='.repeat(70))
  console.log(`STEP 2 — Pointer table at file $${hex(POINTER_TABLE_FILE,6)}`)
  console.log('='.repeat(70))

  // Build offset→token map
  const byOff = new Map(tokens.map(t => [t.fileOff - TOKEN_TABLE_FILE, t]))

  for (let i = 0; i < POINTER_TABLE_COUNT; i++) {
    const off = POINTER_TABLE_FILE + i * 2
    if (off + 1 >= buf.length) break
    const ptr = buf[off] | (buf[off + 1] << 8)
    const token = byOff.get(ptr)
    console.log(`  ptr[${String(i).padStart(2)}] = $${hex(ptr,4)} → "${token?.text ?? '?'}"`)
  }
  console.log()
}

// ── Step 3: Dump bytes just before the token table ───────────────────────────
// The composition table likely lives near the token table in bank $04.

function step3BeforeTable(buf, hasHeader, tokens) {
  console.log('='.repeat(70))
  console.log(`STEP 3 — 256 bytes before token table ($${hex(TOKEN_TABLE_FILE-0x100,6)}–$${hex(TOKEN_TABLE_FILE,6)})`)
  console.log('='.repeat(70))
  console.log('  Interpreting each byte as a token ID to spot composition data:')
  console.log()

  for (let off = TOKEN_TABLE_FILE - 0x100; off < TOKEN_TABLE_FILE; off += 16) {
    const row = buf.slice(off, off + 16)
    const rawHex = [...row].map(b => hex(b)).join(' ')
    const asTokens = [...row].map(b => {
      if (b < tokens.length) return tokens[b].text.slice(0,6).padEnd(6)
      return '?'.padEnd(6)
    }).join(' ')
    console.log(`  $${hex(off,6)}  ${rawHex}`)
    console.log(`            ${asTokens}`)
  }
  console.log()
}

// ── Step 4: Search for composition patterns ───────────────────────────────────
// Look for contiguous regions of bytes where all values are valid token IDs.
// A 96-byte (or 192-byte) table of small values in bank $04 is a strong hint.

function step4CompositionSearch(buf, hasHeader, tokens) {
  console.log('='.repeat(70))
  console.log('STEP 4 — Scan bank $04 for token-ID byte runs (composition table)')
  console.log('='.repeat(70))
  console.log(`  Valid token ID range: 0–${tokens.length - 1}`)
  console.log()

  const maxId = tokens.length - 1
  const bank04Start = loromToOffset(0x048000, hasHeader)
  const bank04End   = loromToOffset(0x050000, hasHeader) ?? buf.length

  for (let off = bank04Start; off < bank04End - 8; off++) {
    // Count how many consecutive bytes are valid token IDs
    let run = 0
    while (off + run < bank04End && buf[off + run] <= maxId) run++

    if (run >= 8) {
      const snes = offsetToSnes(off, hasHeader)
      const raw = [...buf.slice(off, off + Math.min(run, 32))].map(b => hex(b)).join(' ')
      const decoded = [...buf.slice(off, off + Math.min(run, 16))]
        .map(b => `"${tokens[b]?.text ?? '?'}"`)
        .join(' ')
      console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)} — ${run} consecutive valid token IDs`)
      console.log(`    Raw:     ${raw}`)
      console.log(`    Decoded: ${decoded}`)
      off += run - 1  // skip past this run
    }
  }
  console.log()
}

// ── Step 5: Targeted YOSHI'S HOUSE search ────────────────────────────────────

function step5TargetedSearch(buf, hasHeader, tokens) {
  console.log('='.repeat(70))
  console.log("STEP 5 — Targeted search for YOSHI'S HOUSE / YOSHI'S ISLAND")
  console.log('='.repeat(70))

  const yoshisId = tokens.findIndex(t => t.text === "YOSHI'S")
  const houseId  = tokens.findIndex(t => t.text === 'HOUSE')
  const islandId = tokens.findIndex(t => t.text === 'ISLAND')
  const castleId = tokens.findIndex(t => t.text === 'CASTLE')

  console.log(`  Token IDs:  YOSHI'S=${yoshisId}  HOUSE=${houseId}  ISLAND=${islandId}  CASTLE=${castleId}`)
  console.log()

  function searchPair(idA, idB, label) {
    if (idA < 0 || idB < 0) { console.log(`  ${label}: token not found`); return }
    let found = 0
    for (let i = hasHeader ? COPIER_HEADER : 0; i < buf.length - 1; i++) {
      if (buf[i] === idA && buf[i+1] === idB) {
        const snes = offsetToSnes(i, hasHeader)
        const ctx = [...buf.slice(i, i+8)].map(b => hex(b)).join(' ')
        // Decode surrounding context as token IDs
        const ctxDecoded = [...buf.slice(Math.max(i-4,0), i+8)]
          .map(b => b < tokens.length ? tokens[b].text.slice(0,8) : `$${hex(b)}`)
          .join(' ')
        console.log(`  ${label}:  file $${hex(i,6)}  SNES ~$${hex(snes,6)}`)
        console.log(`    Bytes:   ${ctx}`)
        console.log(`    Context: ${ctxDecoded}`)
        found++
      }
    }
    if (!found) console.log(`  ${label}: not found as adjacent bytes`)
  }

  searchPair(yoshisId, houseId,  "YOSHI'S HOUSE  ")
  searchPair(yoshisId, islandId, "YOSHI'S ISLAND ")
  searchPair(yoshisId, castleId, "YOSHI'S CASTLE ")

  // Also search for any byte pair [yoshisId, X] anywhere
  if (yoshisId >= 0) {
    console.log(`\n  All occurrences of token[${yoshisId}]=YOSHI'S followed by any byte:`)
    for (let i = hasHeader ? COPIER_HEADER : 0; i < buf.length - 1; i++) {
      if (buf[i] === yoshisId) {
        const next = buf[i+1]
        const snes = offsetToSnes(i, hasHeader)
        const nextName = next < tokens.length ? tokens[next].text : `$${hex(next)}`
        console.log(`    file $${hex(i,6)} SNES $${hex(snes,6)}: YOSHI'S + ${nextName}`)
      }
    }
  }
  console.log()
}

// ── Entry point ───────────────────────────────────────────────────────────────

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/decode-level-names.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}`)
console.log(`Size: ${buf.length} bytes | Header: ${hasHeader ? 'yes' : 'no'}\n`)

const tokens = step1Tokens(buf, hasHeader)
step2PointerTable(buf, hasHeader, tokens)
step3BeforeTable(buf, hasHeader, tokens)
step4CompositionSearch(buf, hasHeader, tokens)
step5TargetedSearch(buf, hasHeader, tokens)

console.log('Done.')
