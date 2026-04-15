/**
 * decode-overworld-names.mjs
 *
 * Comprehensive dump and analysis of the SMW overworld level name system.
 *
 * Approach:
 * 1. Dump the FULL tile→name_id table at SNES $00E90A (and the 96 bytes before it)
 * 2. Dump SNES $00E8C4 — the area tables (F05C, F0C8 etc. for all 96 entries)
 * 3. Attempt to build a complete tile_type → level_name mapping
 * 4. Look for the overworld entrance/exit data that maps tile→translevel
 * 5. Search in bank $04 just before the token table for any name→level mapping
 *
 * Usage:
 *   node scripts/decode-overworld-names.mjs <rom.sfc>
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

const SEQ_TOKENS = [
  "YOSHI'S","STAR","IGGY'S","MORTON'S","LEMMY'S","LUDWIG'S","ROY'S","WENDY'S",
  "LARRY'S","DONUT","GREEN","TOP SECRET AREA","VANILLA","RED","BLUE",
  "BUTTER BRIDGE","CHEESE BRIDGE","SODA LAKE","COOKIE MOUNTAIN","FOREST",
  "CHOCOLATE","CHOCO GHOST HOUSE","SUNKEN GHOST SHIP","VALLEY","BACK DOOR",
  "FRONT DOOR","GNARLY","TUBULAR","WAY COOL","HOUSE","ISLAND","SWITCH PALACE",
  "CASTLE","PLAINS","GHOST HOUSE","SECRET","DOME","FORTRESS","OF","ON","OF BOWSER",
  "ROAD","WORLD","AWESOME","PALAC","ARE","GROOV","MOND","OUTRAGEOU","FUNK","HOUS","BAAIANAXA"
]
const PTR_TOKENS = [
  "STAR","IGGY'S","MORTON'S","LEMMY'S","LUDWIG'S","ROY'S","WENDY'S","LARRY'S",
  "DONUT","GREEN","TOP SECRET AREA","VANILLA","#","RED","BLUE","BUTTER BRIDGE",
  "CHEESE BRIDGE","SODA LAKE","COOKIE MOUNTAIN","FOREST","CHOCOLATE",
  "CHOCO GHOST HOUSE","SUNKEN GHOST SHIP","VALLEY","BACK DOOR","FRONT DOOR",
  "GNARLY","TUBULAR","WAY COOL",null,"HOUSE","ISLAND","SWITCH PALACE","CASTLE",
  "PLAINS","GHOST HOUSE","SECRET","DOME","FORTRESS","OF","OF BOWSER","ROAD","WORLD",
  "AWESOME",null,"PALAC","ARE","GROOV","MOND","OUTRAGEOU","FUNK","HOUS"
]

function seqName(id) {
  if (id === 0xFF) return '(FF=no name)'
  if (id < SEQ_TOKENS.length) return `"${SEQ_TOKENS[id]}"`
  return `$${hex(id)}`
}
function ptrName(id) {
  if (id === 0xFF) return '(FF=no name)'
  if (id < PTR_TOKENS.length) return `"${PTR_TOKENS[id] ?? '(null)'}"`
  return `$${hex(id)}`
}

const romPath = process.argv[2]
if (!romPath) { console.error('Usage: node scripts/decode-overworld-names.mjs <rom.sfc>'); process.exit(1) }
const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}\nSize: ${buf.length} | Header: ${hasHeader ? 'yes' : 'no'}\n`)

// ── 1. Full dump of the E90A table (tile_type → name_id), extended ────────────
console.log('='.repeat(70))
console.log('SECTION 1 — Full SNES $00E90A tile→name_id table (first 128 entries)')
console.log('='.repeat(70))

const e90a = fileOf(0x00E90A, hasHeader)
console.log(`  File offset: $${hex(e90a, 6)}`)
for (let i = 0; i < 128; i++) {
  const b = buf[e90a + i]
  const nameType = b & 3
  const levelNum = b >> 2
  const typeStr = ['---', 'HOUSE?', 'ISLAND?', 'CASTLE?'][nameType]
  console.log(`  tile[${String(i).padStart(3)}]  name_id=$${hex(b)}  type=${nameType}(${typeStr})  num=${levelNum}`)
}
console.log()

// ── 2. Dump bytes immediately BEFORE the E90A table (to find context) ─────────
console.log('='.repeat(70))
console.log('SECTION 2 — 256 bytes before $00E90A (context/structure before name table)')
console.log('='.repeat(70))

const e90a_ctx_start = e90a - 256
for (let off = e90a_ctx_start; off < e90a; off += 16) {
  const len = Math.min(16, e90a - off)
  const row = buf.slice(off, off + len)
  const h = [...row].map(b => hex(b)).join(' ').padEnd(47)
  const a = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
  const snes = toSnes(off, hasHeader)
  console.log(`  $${hex(snes,6)}  ${h}  |${a}|`)
}
console.log()

// ── 3. Dump the F05C and F0C8 tables (complete 32 entries each) ───────────────
console.log('='.repeat(70))
console.log('SECTION 3 — SNES $00F05C and $00F0C8 tables (display context tables)')
console.log('='.repeat(70))

const f05c = fileOf(0x00F05C, hasHeader)
const f0c8 = fileOf(0x00F0C8, hasHeader)
console.log(`  $00F05C (file $${hex(f05c,6)}) | $00F0C8 (file $${hex(f0c8,6)})`)
for (let i = 0; i < 32; i++) {
  const a = buf[f05c + i]
  const b = buf[f0c8 + i]
  console.log(`  [${String(i).padStart(2)}] F05C=$${hex(a)}  F0C8=$${hex(b)} = ${ptrName(b)}`)
}
console.log()

// ── 4. Search for a table that maps (overworld slot → translevel number) ───────
// In SMW, the overworld "level entrance" table might be at $04C000 or nearby
// Each entrance maps directly to a translevel (0x00-0x5F)
console.log('='.repeat(70))
console.log('SECTION 4 — Search for tile_type→translevel mapping table')
console.log('  Strategy: scan for a 96-byte array where values are ALL in range 0-$5F')
console.log('='.repeat(70))

const base = hasHeader ? COPIER_HEADER : 0
for (let off = base; off < buf.length - 96; off++) {
  let valid = true
  let hasVariety = false
  const seen = new Set()
  for (let i = 0; i < 96; i++) {
    const v = buf[off + i]
    if (v > 0x5F) { valid = false; break }
    seen.add(v)
  }
  if (valid && seen.size >= 30) {
    const snes = toSnes(off, hasHeader)
    const preview = [...buf.slice(off, off+32)].map(b=>hex(b)).join(' ')
    console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)} — 96 bytes in [0,$5F], ${seen.size} distinct vals`)
    console.log(`    ${preview}`)
  }
}
console.log()

// ── 5. Find consecutive level-number values (0,1,2,3,4...) in the ROM ─────────
// An overworld entrance table might store translevels in order
console.log('='.repeat(70))
console.log('SECTION 5 — Search for sequential byte sequences 00 01 02 03...')
console.log('='.repeat(70))

for (let off = base; off < buf.length - 32; off++) {
  let matchLen = 0
  while (off + matchLen < buf.length && buf[off + matchLen] === matchLen && matchLen < 96) matchLen++
  if (matchLen >= 16) {
    const snes = toSnes(off, hasHeader)
    const preview = [...buf.slice(off, off+Math.min(32, matchLen))].map(b=>hex(b)).join(' ')
    console.log(`  file $${hex(off,6)} SNES $${hex(snes,6)}: ${matchLen} sequential bytes 00 01 02...`)
    console.log(`    ${preview}`)
  }
}
console.log()

// ── 6. Dump bank $04 just before token table (area $049000–$049AC5) ───────────
console.log('='.repeat(70))
console.log('SECTION 6 — Bank $04 area $049800–$049AC5 (just before token table)')
console.log('='.repeat(70))

const tokStart = fileOf(0x049AC5, hasHeader)
const dumpStart = tokStart - 0x2C5
for (let off = dumpStart; off < tokStart; off += 16) {
  const len = Math.min(16, tokStart - off)
  const row = buf.slice(off, off + len)
  const h = [...row].map(b => hex(b)).join(' ').padEnd(47)
  const a = [...row].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
  const snes = toSnes(off, hasHeader)
  console.log(`  $${hex(snes,6)}  ${h}  |${a}|`)
}
console.log()

// ── 7. Targeted search: look for ALL known level name pairs in order ──────────
// "YOSHI'S ISLAND 1" = seq[0] ISLAND(30) then tiles 2,3,4,5 as seq[30] seq[30]...
// What if the table stores 1 byte per level that ENCODES the name differently?
// Hypothesis: name_id from E90A directly gives the composition index.
// Let's build a name from each tile_type using E90A name_id.
console.log('='.repeat(70))
console.log('SECTION 7 — Attempt to decode level name for each tile_type 0-95')
console.log('  Using: name_id = E90A[tile], type = name_id & 3, num = name_id >> 2')
console.log('  Suffix types: 0=???, 1=HOUSE, 2=ISLAND, 3=CASTLE')
console.log('  F05C = "world/boss area" index (0-6)')
console.log('  F0C8 = "suffix token" ptr ID')
console.log('='.repeat(70))

const SUFFIX_BY_TYPE = ['(no suffix)', 'HOUSE', 'ISLAND', 'CASTLE']
const AREA_PREFIXES  = ["YOSHI'S","DONUT","VANILLA","FOREST","CHOCOLATE","VALLEY","STAR","???"]

// From F05C values: 01,05,01,02,01,01,00,00,00,00,00,00,00,06,02,02,...
// Possible interpretation: F05C[X/2] = boss_id (1=Iggy,2=Morton,3=Lemmy,4=Ludwig,5=Roy,6=Wendy,0=Larry or no boss)
const BOSS_NAMES = ["LARRY'S","IGGY'S","MORTON'S","LEMMY'S","LUDWIG'S","ROY'S","WENDY'S","???"]

for (let tile = 0; tile < 96; tile++) {
  const nameId = buf[e90a + tile]
  if (nameId === 0xFF) {
    console.log(`  tile[$${hex(tile)}]  name_id=FF → (no name / unreached)`)
    continue
  }
  const type = nameId & 3
  const num  = nameId >> 2

  // Get F05C and F0C8 for this tile (assuming X = tile * 2 + $18 offset is wrong,
  // so let's just try F05C[tile] directly)
  const f05cVal = buf[f05c + tile]
  const f0c8Val = buf[f0c8 + tile]

  const suffix = SUFFIX_BY_TYPE[type]
  const numStr = num > 0 ? ` ${num}` : ''

  // Try different prefix derivations:
  // A: boss prefix from F05C (for castle names)
  // B: area prefix from tile range (for area names)

  let prefix = '???'
  if (type === 3) {
    // Castle type: use F05C as boss_id
    prefix = BOSS_NAMES[f05cVal] ?? `boss[${f05cVal}]`
  } else {
    // Non-castle: use F0C8 as area prefix (ptr ID)
    prefix = PTR_TOKENS[f0c8Val] ?? `ptr[${hex(f0c8Val)}]`
  }

  console.log(`  tile[$${hex(tile)}]  name_id=$${hex(nameId)}  type=${type}  num=${num}  F05C=$${hex(f05cVal)}  F0C8=$${hex(f0c8Val)}`)
  console.log(`    → "${prefix} ${suffix}${numStr}" (experimental decode)`)
}

console.log('\nDone.')
