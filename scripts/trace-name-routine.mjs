/**
 * trace-name-routine.mjs
 *
 * Investigates the SMW level name display architecture:
 *
 * 1. Dumps the name display routine at SNES $00F127 (file $007127)
 *    to identify how it uses name_id to look up token sequences.
 *
 * 2. Dumps the data at SNES $00A625 (file $002625) as a candidate
 *    composition table (name_id → token sequence).
 *
 * 3. Cross-references all pointer-table token IDs (0=STAR, 1=IGGY'S, …
 *    30=HOUSE, 31=ISLAND, 33=CASTLE, 34=PLAINS, 37=DOME, 42=WORLD, …)
 *    to decode any composition entries found.
 *
 * 4. Also scans the full name display routine for any `LDA long,X`
 *    (opcode $BF) or `LDA abs,X` (opcode $BD) references to identify
 *    ALL tables the routine uses.
 *
 * Usage:
 *   node scripts/trace-name-routine.mjs <rom.sfc>
 */

import * as fs from 'fs'

const COPIER_HEADER = 512

// Unheadered ROM offsets (subtract $200 if headered)
const F127_FILE = 0x007127   // SNES $00F127 — name display entry
const A625_FILE = 0x002625   // SNES $00A625 — suspected composition table

// Token pointer table (from earlier session decoding):
// pointer-table IDs 0..56, with 29 and 44 being null.
// These are the IDs used in the composition table.
const TOKENS = [
  /*  0 */ 'STAR',
  /*  1 */ "IGGY'S",
  /*  2 */ "MORTON'S",
  /*  3 */ "LEMMY'S",
  /*  4 */ "LUDWIG'S",
  /*  5 */ "ROY'S",
  /*  6 */ "WENDY'S",
  /*  7 */ "LARRY'S",
  /*  8 */ 'DONUT',
  /*  9 */ 'GREEN',
  /* 10 */ 'TOP SECRET AREA',
  /* 11 */ 'VANILLA',
  /* 12 */ '#',         // digit tokens $38–$3C
  /* 13 */ 'RED',
  /* 14 */ 'BLUE',
  /* 15 */ 'BUTTER BRIDGE',
  /* 16 */ 'CHEESE BRIDGE',
  /* 17 */ 'SODA LAKE',
  /* 18 */ 'COOKIE MOUNTAIN',
  /* 19 */ 'FOREST',
  /* 20 */ 'CHOCOLATE',
  /* 21 */ 'CHOCO GHOST HOUSE',
  /* 22 */ 'SUNKEN GHOST SHIP',
  /* 23 */ 'VALLEY',
  /* 24 */ 'BACK DOOR',
  /* 25 */ 'FRONT DOOR',
  /* 26 */ 'GNARLY',
  /* 27 */ 'TUBULAR',
  /* 28 */ 'WAY COOL',
  /* 29 */ null,
  /* 30 */ 'HOUSE',
  /* 31 */ 'ISLAND',
  /* 32 */ 'SWITCH PALACE',
  /* 33 */ 'CASTLE',
  /* 34 */ 'PLAINS',
  /* 35 */ 'GHOST HOUSE',
  /* 36 */ 'SECRET',
  /* 37 */ 'DOME',
  /* 38 */ 'FORTRESS',
  /* 39 */ 'OF',
  /* 40 */ 'OF BOWSER',
  /* 41 */ 'ROAD',
  /* 42 */ 'WORLD',
  /* 43 */ 'AWESOME',
  /* 44 */ null,
  /* 45 */ 'PALAC',      // partial — likely "PALACE" suffix
  /* 46 */ 'ARE',        // partial — likely "AREA" suffix
  /* 47 */ 'GROOV',      // partial — likely "GROOVY"
  /* 48 */ 'MOND',       // partial — likely "MONDO"
  /* 49 */ 'OUTRAGEOU',  // partial — likely "OUTRAGEOUS"
  /* 50 */ 'FUNK',       // partial — likely "FUNKY"
  /* 51 */ 'HOUS',       // partial — likely "HOUSE" (alt?)
]

// Tile → name_id table (from earlier tracing of $00E90A)
// Index = overworld tile object ID, value = name_id (0xFF = no name)
const TILE_NAME_IDS = [
  1, 2, 17, 0xFF, 0xFF, 1, 0, 2, 13, 1, 0, 0xFF, 0xFF, 1, 0, 1,
  0, 0xFF, 0xFF, 0xFF, 0xFF, 0, 0, 0, 0, 0xFF, 0xFF, 1, 0, 0xFF, 0xFF, 1,
  0, 32  // last two: tile 32 → name_id 0, tile 33 → name_id 32
]

function loadRom(path) {
  const buf = fs.readFileSync(path)
  const hasHeader = (buf.length % 1024) === COPIER_HEADER
  return { buf, hasHeader }
}

function fileOff(snes, hasHeader) {
  const bank = (snes >>> 16) & 0x7F
  const addr = snes & 0xFFFF
  if (addr < 0x8000) return (bank * 0x10000 + addr) - (hasHeader ? 0 : 0) + (hasHeader ? COPIER_HEADER : 0)
  return bank * 0x8000 + (addr - 0x8000) + (hasHeader ? COPIER_HEADER : 0)
}

function toSnes(off, hasHeader) {
  const o = off - (hasHeader ? COPIER_HEADER : 0)
  const bank = Math.floor(o / 0x8000)
  const addr = 0x8000 + (o % 0x8000)
  return (bank << 16) | addr
}

function hex(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, '0') }

function tokenName(id) {
  if (id === 0xFF) return '(none)'
  if (id < TOKENS.length) return TOKENS[id] ?? `(null@${id})`
  return `?(${id})`
}

// ── STEP 1: Raw hex dump of $00F127 routine ──────────────────────────────────

function dumpF127(buf, hasHeader) {
  const f127 = F127_FILE + (hasHeader ? COPIER_HEADER : 0)
  console.log('='.repeat(70))
  console.log(`STEP 1 — Name display routine at SNES $00F127 (file $${hex(f127, 6)})`)
  console.log('='.repeat(70))
  console.log('  Raw hex dump (256 bytes):')
  for (let off = f127; off < f127 + 256; off += 16) {
    const row = buf.slice(off, off + 16)
    const h = [...row].map(b => hex(b)).join(' ')
    const snes = toSnes(off, hasHeader)
    console.log(`  $${hex(snes, 6)}  ${h}`)
  }
  console.log()
}

// ── STEP 2: Find all long/abs table references in $00F127 routine ────────────

function findTableRefs(buf, hasHeader) {
  const f127 = F127_FILE + (hasHeader ? COPIER_HEADER : 0)
  console.log('='.repeat(70))
  console.log('STEP 2 — Table references (BF/BD opcodes) in $F127...$F227')
  console.log('='.repeat(70))

  for (let off = f127; off < f127 + 256; off++) {
    const op = buf[off]
    if (op === 0xBF) {
      // LDA long,X — 4 bytes: BF ll hh bb
      if (off + 3 < buf.length) {
        const addr = buf[off+1] | (buf[off+2] << 8) | (buf[off+3] << 16)
        const snes = toSnes(off, hasHeader)
        console.log(`  SNES $${hex(snes, 6)}: LDA $${hex(addr, 6)},X`)
      }
    } else if (op === 0xBD) {
      // LDA abs,X — 3 bytes: BD ll hh
      if (off + 2 < buf.length) {
        const addr = buf[off+1] | (buf[off+2] << 8)
        const snes = toSnes(off, hasHeader)
        console.log(`  SNES $${hex(snes, 6)}: LDA $${hex(addr, 4)},X`)
      }
    } else if (op === 0xB9) {
      // LDA abs,Y
      if (off + 2 < buf.length) {
        const addr = buf[off+1] | (buf[off+2] << 8)
        const snes = toSnes(off, hasHeader)
        console.log(`  SNES $${hex(snes, 6)}: LDA $${hex(addr, 4)},Y`)
      }
    } else if (op === 0xAF) {
      // LDA long
      if (off + 3 < buf.length) {
        const addr = buf[off+1] | (buf[off+2] << 8) | (buf[off+3] << 16)
        const snes = toSnes(off, hasHeader)
        console.log(`  SNES $${hex(snes, 6)}: LDA $${hex(addr, 6)}`)
      }
    } else if (op === 0x22) {
      // JSL
      if (off + 3 < buf.length) {
        const addr = buf[off+1] | (buf[off+2] << 8) | (buf[off+3] << 16)
        const snes = toSnes(off, hasHeader)
        console.log(`  SNES $${hex(snes, 6)}: JSL $${hex(addr, 6)}`)
      }
    } else if (op === 0x20) {
      // JSR
      if (off + 2 < buf.length) {
        const addr = buf[off+1] | (buf[off+2] << 8)
        const snes = toSnes(off, hasHeader)
        console.log(`  SNES $${hex(snes, 6)}: JSR $${hex(addr, 4)}`)
      }
    } else if (op === 0x6B || op === 0x60) {
      const snes = toSnes(off, hasHeader)
      console.log(`  SNES $${hex(snes, 6)}: ${op === 0x6B ? 'RTL' : 'RTS'}`)
    }
  }
  console.log()
}

// ── STEP 3: Dump SNES $00A625 as composition table ───────────────────────────

function dumpA625(buf, hasHeader) {
  // $00A625 is in bank $00, low-ROM shadow area (< $8000) — file offset same as SNES
  const a625 = 0x002625 + (hasHeader ? COPIER_HEADER : 0)
  console.log('='.repeat(70))
  console.log(`STEP 3 — Data at SNES $00A625 (file $${hex(a625, 6)})`)
  console.log('='.repeat(70))

  // Raw hex context
  console.log('  Raw hex (128 bytes):')
  for (let off = a625; off < a625 + 128; off += 16) {
    const row = buf.slice(off, off + 16)
    const h = [...row].map(b => hex(b)).join(' ')
    const a = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
    console.log(`  $${hex(off, 6)}  ${h}   |${a}|`)
  }
  console.log()

  // Try to decode as 2-byte composition pairs [prefix_token][suffix_token]
  console.log('  Decoded as 2-byte pairs [prefix][suffix]:')
  for (let i = 0; i < 64; i++) {
    const off = a625 + i * 2
    const a = buf[off]
    const b = buf[off + 1]
    const nameA = tokenName(a)
    const nameB = tokenName(b)
    const valid = a < TOKENS.length && b < TOKENS.length && TOKENS[a] && TOKENS[b]
    const mark = valid ? '  ✓' : ''
    console.log(`  [${String(i).padStart(2)}]  $${hex(a)} $${hex(b)}  →  "${nameA} ${nameB}"${mark}`)
  }
  console.log()

  // Try to decode as 1-byte sequences terminated by $FF
  console.log('  Decoded as variable-length sequences (terminated by $FF):')
  let off = a625
  let seqId = 0
  while (off < a625 + 128 && seqId < 40) {
    const start = off
    const tokens = []
    while (off < a625 + 256 && buf[off] !== 0xFF) {
      tokens.push(buf[off])
      off++
    }
    const name = tokens.map(t => tokenName(t)).join(' ')
    const raw = tokens.map(t => hex(t)).join(' ')
    console.log(`  seq[${String(seqId).padStart(2)}]  $${hex(start, 6)}: [${raw}]  →  "${name}"`)
    if (buf[off] === 0xFF) off++  // skip terminator
    seqId++
    if (tokens.length === 0) break
  }
  console.log()
}

// ── STEP 4: Scan bank $00 low region for name_id-indexed structures ──────────

function scanBank00Low(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('STEP 4 — Scan SNES $00:8000–$00:FFFF for token-ID byte runs')
  console.log('='.repeat(70))

  // Bank $00 ROM portion: SNES $008000–$00FFFF = file $0000–$7FFF (+ header)
  // (bank $00 high half only — low half is mirrors/WRAM in SNES but ROM in LoROM at file $0000)
  const base = hasHeader ? COPIER_HEADER : 0
  const bankEnd = base + 0x8000
  const maxId = TOKENS.length - 1

  let hits = 0
  for (let off = base; off < bankEnd - 4; off++) {
    let run = 0
    while (off + run < bankEnd && buf[off + run] <= maxId && TOKENS[buf[off + run]] !== undefined) run++
    if (run >= 4) {
      const snes = toSnes(off, hasHeader)
      // Show as pairs
      const pairs = []
      for (let p = 0; p + 1 < run; p += 2) {
        const a = buf[off + p]
        const b = buf[off + p + 1]
        pairs.push(`[${hex(a)} ${hex(b)}]="${tokenName(a)} ${tokenName(b)}"`)
      }
      if (run % 2 === 1) {
        const last = buf[off + run - 1]
        pairs.push(`[${hex(last)}]="${tokenName(last)}"`)
      }
      console.log(`  file $${hex(off, 6)} SNES $${hex(snes, 6)} — ${run} bytes: ${pairs.join(', ')}`)
      off += run - 1
      hits++
    }
  }
  if (!hits) console.log('  (no runs of 4+ valid token IDs found)')
  console.log()
}

// ── STEP 5: Dump the E90A table more carefully ───────────────────────────────

function dumpE90A(buf, hasHeader) {
  // SNES $00E90A = file $00690A (unheadered)
  const e90a = 0x00690A + (hasHeader ? COPIER_HEADER : 0)
  console.log('='.repeat(70))
  console.log(`STEP 5 — Tile→name_id table at SNES $00E90A (file $${hex(e90a, 6)})`)
  console.log('='.repeat(70))

  console.log('  Tile  NameID  Name(if known)')
  for (let tile = 0; tile < 96; tile++) {
    const b = buf[e90a + tile]
    const marker = b === 0xFF ? '  (no name)' : ''
    const name = b < TOKENS.length && TOKENS[b] ? `  "${TOKENS[b]}"` : ''
    console.log(`  [${String(tile).padStart(2)}]  $${hex(b)}${marker}${name}`)
    // Stop if we clearly hit code (common opcodes)
    if (tile > 10 && (b === 0xA9 || b === 0x85 || b === 0x20 || b === 0x22 || b === 0x4C || b === 0x60)) {
      console.log(`  ... likely hit machine code at tile ${tile}, stopping`)
      break
    }
  }
  console.log()
}

// ── STEP 6: Look for pointer table that indexes into composition sequences ───
// The composition table may be a pointer table (16-bit offsets) where
// name_id indexes into an array of pointers, each pointing to a token sequence.

function searchForCompositionPointers(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('STEP 6 — Search for name_id pointer table (16-bit LE → token sequences)')
  console.log('='.repeat(70))

  // Strategy: we know "YOSHI'S HOUSE" exists as a name.
  // YOSHI'S is NOT in the pointer table (special case, id=0 in token table).
  // If the composition table uses token-table offsets rather than pointer-table IDs,
  // YOSHI'S would be at offset $0000 from the token table.
  //
  // Actually, let me reconsider: maybe YOSHI'S *is* referenced by some ID.
  // The pointer table starts at $021C95. Entry 0 = STAR. But YOSHI'S is at
  // the very start of the token table ($021AC5) with offset $0000 from base.
  //
  // Let's search for 2-byte value $0000 at even alignment near bank $04 or $00,
  // followed by what would be HOUSE (ptr ID 30) and ISLAND (ptr ID 31).
  //
  // OR: The composition table stores raw token-table internal IDs, not pointer IDs.
  // In that internal sequential ordering, YOSHI'S = 0, STAR = 1, etc.
  // Let's check: what are the sequential internal IDs?
  // parseTokens() from decode-level-names gives: [0]=YOSHI'S, [1]=STAR, ...
  // matching the pointer table IDs shifted by 1 (since ptr[0]=STAR not YOSHI'S).
  //
  // YOSHI'S internal = 0; HOUSE internal = 29; ISLAND internal = 30
  // Searching for [0x00, 0x1D] (YOSHI'S=0, HOUSE=29) in the ROM:

  const pairs = [
    { a: 0x00, b: 0x1D, label: "YOSHI'S(internal=0) HOUSE(internal=29=0x1D)" },
    { a: 0x00, b: 0x1E, label: "YOSHI'S(internal=0) ISLAND(internal=30=0x1E)" },
    { a: 0x08, b: 0x21, label: "DONUT(internal=8 or ptr=8) PLAINS(ptr=34=0x22)" },
    { a: 0x08, b: 0x22, label: "DONUT(ptr=8) PLAINS(ptr=34=0x22)" },
    // ptr IDs:
    { a: 0x1E, b: 0x1F, label: "HOUSE(ptr=30=0x1E) ISLAND(ptr=31=0x1F) adjacent in table" },
  ]

  const base = hasHeader ? COPIER_HEADER : 0
  for (const { a, b, label } of pairs) {
    let found = 0
    for (let i = base; i < buf.length - 1; i++) {
      if (buf[i] === a && buf[i+1] === b) {
        const snes = toSnes(i, hasHeader)
        const ctx = [...buf.slice(Math.max(i-4,0), i+8)].map(x => hex(x)).join(' ')
        console.log(`  ${label}`)
        console.log(`    file $${hex(i,6)} SNES $${hex(snes,6)}: ${ctx}`)
        found++
        if (found >= 4) { console.log('    ... (more)'); break }
      }
    }
    if (!found) console.log(`  ${label}: NOT FOUND`)
    console.log()
  }
}

// ── Entry point ───────────────────────────────────────────────────────────────

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/trace-name-routine.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}`)
console.log(`Size: ${buf.length} | Header: ${hasHeader ? 'yes ($200)' : 'no'}\n`)

dumpF127(buf, hasHeader)
findTableRefs(buf, hasHeader)
dumpA625(buf, hasHeader)
scanBank00Low(buf, hasHeader)
dumpE90A(buf, hasHeader)
searchForCompositionPointers(buf, hasHeader)

console.log('Done.')
