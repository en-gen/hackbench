/**
 * build-translevel-names.mjs
 *
 * Builds the complete translevel → display name table for SMW's overworld.
 *
 * Pipeline:
 *   1. Read $05D608 (SNES) = tile_pos → translevel reverse lookup
 *      Invert it to: tile_pos → translevel
 *   2. Read $00E90A (SNES, file $00690A) = tile_type → name_id
 *      Working hypothesis: tile_type == tile_pos (same index)
 *   3. Decode name_id via the token text table at $049AC5
 *
 * Also attempts to find a DIRECT translevel → name_id table if one exists.
 *
 * Usage:
 *   node scripts/build-translevel-names.mjs <rom.sfc>
 */

import * as fs from 'fs'

const COPIER_HEADER = 512

function loadRom(path) {
  const buf = fs.readFileSync(path)
  const hasHeader = (buf.length % 1024) === COPIER_HEADER
  return { buf, hasHeader }
}

function hex(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, '0') }

function fileOf(snes, hasHeader) {
  const bank = (snes >>> 16) & 0x7F
  const addr = snes & 0xFFFF
  if (addr < 0x8000) return addr + (hasHeader ? COPIER_HEADER : 0)
  return bank * 0x8000 + (addr - 0x8000) + (hasHeader ? COPIER_HEADER : 0)
}

function toSnes(off, hasHeader) {
  const o = off - (hasHeader ? COPIER_HEADER : 0)
  const bank = Math.floor(o / 0x8000)
  const addr = 0x8000 + (o % 0x8000)
  return (bank << 16) | addr
}

function rawDump(buf, hasHeader, label, startSnes, dumpLen) {
  const start = fileOf(startSnes, hasHeader)
  console.log('='.repeat(72))
  console.log(label)
  console.log(`  SNES $${hex(startSnes,6)}  file $${hex(start,6)}  (${dumpLen} bytes)`)
  console.log('='.repeat(72))
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

// ── Token text table decoder ───────────────────────────────────────────────────
// Each token is a run of letter bytes (0x00=A … 0x19=Z), apostrophe (0x5D),
// spaces encoded as 0x1F (standalone space tile), digits encoded as special tiles.
// Tokens are separated by 0x5A (or other non-letter bytes).

const TOKEN_TABLE_SNES = 0x049AC5
const TOKEN_TABLE_FILE_UNHEADERED = 0x021AC5

function parseTokenTable(buf, hasHeader) {
  const base = fileOf(TOKEN_TABLE_SNES, hasHeader)
  const tokens = []  // index = sequential token ID
  let i = base
  const end = base + 0x400  // scan 1K bytes

  while (i < end && tokens.length < 80) {
    // Skip non-letter bytes to find next token start
    while (i < end && !((buf[i] >= 0x00 && buf[i] <= 0x19) || buf[i] === 0x5D)) {
      i++
    }
    if (i >= end) break

    const tokenStart = i
    let text = ''

    while (i < end) {
      const b = buf[i]
      if (b >= 0x00 && b <= 0x19) {
        text += String.fromCharCode(0x41 + b)  // A=0, B=1, ...
        i++
      } else if (b === 0x5D) {
        text += "'"
        i++
      } else if ((b === 0x1F || b === 0x1C) && i + 1 < end && buf[i + 1] >= 0x00 && buf[i + 1] <= 0x19) {
        text += ' '
        i++
      } else {
        break
      }
    }

    if (text.length >= 2) {
      tokens.push({ id: tokens.length, fileOff: tokenStart, text })
    }
  }

  return tokens
}

// ── Pointer table decoder ─────────────────────────────────────────────────────
// After the token text, a table of 16-bit LE offsets (relative to TOKEN_TABLE_FILE)
// provides a secondary ordered list (ptr IDs).

function parsePtrTable(buf, hasHeader, tokens) {
  const ptrTableBase = fileOf(TOKEN_TABLE_SNES, hasHeader) + 0x01D0  // approximate
  const byFileOff = new Map(tokens.map(t => [t.fileOff, t]))
  const tokenFileBase = fileOf(TOKEN_TABLE_SNES, hasHeader)
  const ptrs = []

  for (let i = 0; i < 60; i++) {
    const off = ptrTableBase + i * 2
    if (off + 1 >= buf.length) break
    const rel = buf[off] | (buf[off + 1] << 8)
    if (rel > 0x0500) break  // sanity check
    const targetFile = tokenFileBase + rel
    const tok = byFileOff.get(targetFile)
    ptrs.push({ ptrId: i, rel, text: tok?.text ?? null, seqId: tok?.id ?? null })
  }

  return ptrs
}

// ── Step 1: Read $05D608 table → build tile_pos→translevel map ────────────────

function buildPosToTranslevel(buf, hasHeader) {
  // $05D608: indexed by translevel lo byte → overworld tile_pos
  // Table entries: FF = not on overworld, else tile_pos
  const tableBase = fileOf(0x05D608, hasHeader)
  const posToTrans = new Map()   // tile_pos → translevel (main = 0x000–0x0FF)
  const transToPos = new Map()   // translevel → tile_pos

  for (let tl = 0x01; tl <= 0xFF; tl++) {
    const tilePos = buf[tableBase + tl]
    if (tilePos !== 0xFF) {
      transToPos.set(tl, tilePos)
      posToTrans.set(tilePos, tl)
    }
  }

  return { posToTrans, transToPos }
}

// ── Step 2: Read E90A table at CORRECT file offset ────────────────────────────

function readNameIdTable(buf, hasHeader) {
  // SNES $00E90A → file $00690A (verified: bank=0, addr=$E90A >= $8000)
  const tableBase = fileOf(0x00E90A, hasHeader)
  console.log(`E90A table at file $${hex(tableBase, 6)} (SNES $00E90A)`)
  const nameIds = []
  for (let i = 0; i < 128; i++) {
    nameIds.push(buf[tableBase + i])
  }
  return nameIds
}

// ── Step 3: Decode a name_id into display text ────────────────────────────────
// The E90A byte: bits[1:0] = suffix type (0=none,1=HOUSE,2=ISLAND,3=CASTLE),
//                bits[7:2] = "number" (actually an index into a prefix table)
// This is the previous hypothesis. Let's also try reading it directly as a
// sequential token index.

const SUFFIX_TYPES = ['', ' HOUSE', ' ISLAND', ' CASTLE']

// The F0C8 table (ptr IDs) maps tile_type → prefix token ptr ID
// The F05C table maps tile_type → a secondary attribute
// We'll decode using the actual E90A name_id structure:
//   lo 2 bits = type, hi 6 bits = num (prefix or full name ID)

function decodeNameId(nameId, tokens, ptrs, f0c8Val, f05cVal) {
  if (nameId === 0xFF) return '(no name)'

  const type = nameId & 3
  const num  = nameId >> 2

  // Option A: num is a direct sequential token ID (prefix)
  const seqPrefix = tokens[num]
  const suffix = SUFFIX_TYPES[type]
  const optA = seqPrefix ? `${seqPrefix.text}${suffix}` : `seq[${num}]${suffix}`

  // Option B: num is a ptr ID
  const ptrPrefix = ptrs[num]
  const optB = ptrPrefix?.text ? `${ptrPrefix.text}${suffix}` : `ptr[${num}]${suffix}`

  return { type, num, optA, optB, f0c8Val, f05cVal }
}

// ── Main ──────────────────────────────────────────────────────────────────────

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/build-translevel-names.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}`)
console.log(`Size: ${buf.length} | Header: ${hasHeader ? 'yes (+512)' : 'no'}`)
console.log()

// ── Dump raw E90A table bytes ─────────────────────────────────────────────────
rawDump(buf, hasHeader, 'SNES $00E90A — tile_type → name_id table (128 bytes)', 0x00E90A, 0x80)

// ── Parse token table ─────────────────────────────────────────────────────────
const tokens = parseTokenTable(buf, hasHeader)
console.log('='.repeat(72))
console.log(`TOKEN TABLE at SNES $${hex(TOKEN_TABLE_SNES,6)}: ${tokens.length} tokens found`)
console.log('='.repeat(72))
for (const t of tokens) {
  console.log(`  seq[${String(t.id).padStart(2)}]  "${ t.text}"`)
}
console.log()

const ptrs = parsePtrTable(buf, hasHeader, tokens)
console.log('='.repeat(72))
console.log('POINTER TABLE: ptr_id → token')
console.log('='.repeat(72))
for (const p of ptrs) {
  const name = p.text ? `"${p.text}"` : '(no match)'
  console.log(`  ptr[${String(p.ptrId).padStart(2)}]  rel=$${hex(p.rel,4)}  ${name}`)
}
console.log()

// ── Read auxiliary tables F05C and F0C8 ───────────────────────────────────────
const f05cBase = fileOf(0x00F05C, hasHeader)
const f0c8Base = fileOf(0x00F0C8, hasHeader)

rawDump(buf, hasHeader, 'SNES $00F05C — aux table A (96 bytes)', 0x00F05C, 0x60)
rawDump(buf, hasHeader, 'SNES $00F0C8 — aux table B (96 bytes)', 0x00F0C8, 0x60)

// ── Read E90A name_ids ────────────────────────────────────────────────────────
const nameIds = readNameIdTable(buf, hasHeader)
console.log()

// ── Build tile_pos → translevel map ──────────────────────────────────────────
const { posToTrans, transToPos } = buildPosToTranslevel(buf, hasHeader)

// ── Full table: tile_type (= tile_pos hypothesis) → translevel → name ─────────
console.log('='.repeat(72))
console.log('FULL MAPPING: tile_type → translevel → decoded name')
console.log('  (assumes tile_type index == overworld tile_pos from $05D608 inversion)')
console.log('='.repeat(72))

let validCount = 0
for (let tileType = 0; tileType < 96; tileType++) {
  const nameId = nameIds[tileType]
  const translevel = posToTrans.get(tileType)
  if (nameId === 0xFF && translevel === undefined) continue

  const f05c = buf[f05cBase + tileType]
  const f0c8 = buf[f0c8Base + tileType]
  const decoded = (nameId !== 0xFF) ? decodeNameId(nameId, tokens, ptrs, f0c8, f05c) : null

  const tlStr = translevel !== undefined ? `$${hex(translevel, 3)}` : '---'
  const nameStr = decoded
    ? `name_id=$${hex(nameId)}  type=${decoded.type}  num=${decoded.num}` +
      `  optA="${decoded.optA}"  optB="${decoded.optB}"`
    : `name_id=FF (no name)`

  console.log(`  tile[$${hex(tileType)}]  translevel=${tlStr}  ${nameStr}  F05C=$${hex(f05c)}  F0C8=$${hex(f0c8)}`)
  validCount++
}
console.log(`\n  ${validCount} valid entries`)
console.log()

// ── Direct search: is there a table mapping translevel → name_id directly? ───
// Lunar Magic's "Edit Level Names" suggests there's a 512-entry table where
// each translevel has a direct name assignment.
// Search for a pattern: translevel $104 (YOSHI'S HOUSE) → some name_id byte,
// preceded/followed by reasonable values.

console.log('='.repeat(72))
console.log('SEARCH: Direct translevel→name_id table')
console.log('  Looking for 256-byte+ arrays with values all in name_id range (0-$3F or 0-$7F)')
console.log('  and at least 20 distinct values')
console.log('='.repeat(72))

const base = hasHeader ? COPIER_HEADER : 0
for (let off = base; off < buf.length - 256; off++) {
  let valid = true
  const seen = new Set()
  for (let i = 0; i < 256; i++) {
    const v = buf[off + i]
    if (v > 0x7F && v !== 0xFF) { valid = false; break }
    seen.add(v)
  }
  if (valid && seen.size >= 20) {
    const snes = toSnes(off, hasHeader)
    const preview = [...buf.slice(off, off + 32)].map(b => hex(b)).join(' ')
    console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)}: 256 bytes, ${seen.size} distinct`)
    console.log(`    [${preview}]`)
  }
}
console.log()

// ── Dump the area in bank $04 around what might be the name→level table ───────
rawDump(buf, hasHeader, 'SNES $04C000 — overworld data (256 bytes)', 0x04C000, 0x100)
rawDump(buf, hasHeader, 'SNES $04C500 — overworld data (256 bytes)', 0x04C500, 0x100)
rawDump(buf, hasHeader, 'SNES $04CC00 — overworld data (256 bytes)', 0x04CC00, 0x100)

// ── Also: is there a Yoshi's Island (high translevel) sub-table? ──────────────
// The $05D608 table only covers $01-$FF (8-bit). Yoshi's Island uses $101-$13F.
// There might be a secondary table for high translevels.
// Search bank $05 near $05D608 for a similar table.

console.log('='.repeat(72))
console.log('Searching for sub-map level entry table (high translevels $100-$1FF)')
console.log('  Look at $05D608 + $100 = SNES $05D708 area')
console.log('='.repeat(72))
rawDump(buf, hasHeader, 'SNES $05D700 — possible hi-translevel entrance table', 0x05D700, 0x100)

console.log('\nDone.')
