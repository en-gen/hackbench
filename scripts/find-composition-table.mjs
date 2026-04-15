/**
 * find-composition-table.mjs
 *
 * Step 1: Read the pointer table at $021E95.
 *   Each 16-bit LE entry is an offset from the start of the token table ($021CC5).
 *   This gives us the ACTUAL runtime token ID → token text mapping.
 *
 * Step 2: Re-search the entire ROM for 2-byte pair [YOSHI'S_id][HOUSE_id]
 *   and [YOSHI'S_id][ISLAND_id] using the real pointer-table IDs.
 *
 * Step 3: Dump and decode the region around any match as a composition table,
 *   with each 2-byte entry decoded as [token_A][token_B].
 *
 * Step 4: If a clean run of recognizable level name pairs is found, dump all
 *   entries and show their implied level-slot → name mapping.
 *
 * Usage:
 *   node scripts/find-composition-table.mjs <rom.sfc>
 */

import * as fs from 'fs'

const COPIER_HEADER     = 512
// These offsets are for the UNHEADERED ROM (524288 bytes, no copier header).
// If using a headered ROM (524800 bytes), add 0x200 to each.
const TOKEN_TABLE_FILE   = 0x021AC5  // SNES $049AC5 — confirmed by YOSHI byte search
const POINTER_TABLE_FILE = 0x021C95  // TOKEN_TABLE_FILE + 0x01D0 (estimated)
// How many pointer entries to read — scan until we hit a nonsense offset
const MAX_PTR_ENTRIES   = 96

function loadRom(path) {
  const buf = fs.readFileSync(path)
  const hasHeader = (buf.length % 1024) === COPIER_HEADER
  return { buf, hasHeader }
}

function hex(n, w = 2) { return n.toString(16).toUpperCase().padStart(w, '0') }

function offsetToSnes(fileOff, hasHeader) {
  const romOff = fileOff - (hasHeader ? COPIER_HEADER : 0)
  const bank = Math.floor(romOff / 0x8000)
  const addr = 0x8000 + (romOff % 0x8000)
  return (bank << 16) | addr
}

// ── Decode one tile-encoded token starting at buf[off] ─────────────────────

function decodeTileToken(buf, off, endOff) {
  let text = ''
  let i = off
  while (i < endOff) {
    const b = buf[i]
    if (b >= 0x00 && b <= 0x19) {
      text += String.fromCharCode(65 + b)
      i++
    } else if (b === 0x5D) {
      text += "'"
      i++
    } else if (b === 0x1F || b === 0x1C) {
      const next = (i + 1 < endOff) ? buf[i + 1] : 0xFF
      if (next >= 0x00 && next <= 0x19) { text += ' '; i++ }
      else { i++; break }
    } else {
      if (b === 0x9F) i++
      break
    }
  }
  return text
}

// ── Step 1: Build pointer-table → token mapping ───────────────────────────

function buildPointerTable(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log(`STEP 1 — Pointer table at file $${hex(POINTER_TABLE_FILE, 6)}`)
  console.log('='.repeat(70))

  const tokenTableLen = POINTER_TABLE_FILE - TOKEN_TABLE_FILE  // ~$1D0 bytes
  const byId = []  // byId[ptrIndex] = { id, text }

  for (let i = 0; i < MAX_PTR_ENTRIES; i++) {
    const ptrOff = POINTER_TABLE_FILE + i * 2
    if (ptrOff + 1 >= buf.length) break
    const ptr = buf[ptrOff] | (buf[ptrOff + 1] << 8)
    // ptr is offset from start of token table
    if (ptr >= tokenTableLen + 0x200) break  // sanity: past end of region
    const tokenFileOff = TOKEN_TABLE_FILE + ptr
    if (tokenFileOff >= buf.length) break
    const text = decodeTileToken(buf, tokenFileOff, tokenFileOff + 32)
    if (text.length < 2) break  // nonsense entry — stop
    byId.push({ id: i, ptr, fileOff: tokenFileOff, text })
  }

  for (const t of byId) {
    console.log(`  ptr[${String(t.id).padStart(2)}]  $${hex(t.ptr, 4)}  → file $${hex(t.fileOff, 6)}  "${t.text}"`)
  }
  console.log(`\n  ${byId.length} entries read.\n`)
  return byId
}

// ── Step 2: Re-search for YOSHI'S HOUSE / ISLAND using real pointer IDs ───

function searchWithRealIds(buf, hasHeader, byId) {
  console.log('='.repeat(70))
  console.log("STEP 2 — Search ROM for [YOSHI'S][HOUSE], [YOSHI'S][ISLAND], etc.")
  console.log('='.repeat(70))

  const pairs = [
    ["YOSHI'S", 'HOUSE'],
    ["YOSHI'S", 'ISLAND'],
    ["YOSHI'S", 'CASTLE'],
    ['DONUT',   'PLAINS'],
    ['IGGY\'S', 'CASTLE'],
    ['STAR',    'WORLD'],
    ['VANILLA', 'DOME'],
    ['VALLEY',  'OF BOWSER'],
  ]

  for (const [a, b] of pairs) {
    const idA = byId.findIndex(t => t.text === a)
    const idB = byId.findIndex(t => t.text === b)
    if (idA < 0 || idB < 0) {
      console.log(`  "${a} ${b}": token not found in pointer table (idA=${idA} idB=${idB})`)
      continue
    }
    let found = 0
    for (let i = hasHeader ? COPIER_HEADER : 0; i < buf.length - 1; i++) {
      if (buf[i] === idA && buf[i + 1] === idB) {
        const snes = offsetToSnes(i, hasHeader)
        const ctx = [...buf.slice(Math.max(i - 4, 0), i + 8)]
          .map(b2 => {
            const t = byId[b2]
            return t ? `"${t.text}"` : `$${hex(b2)}`
          }).join(' ')
        console.log(`  "${a} ${b}" [${hex(idA)} ${hex(idB)}]:  file $${hex(i, 6)}  SNES $${hex(snes, 6)}`)
        console.log(`    Context: ${ctx}`)
        found++
        if (found >= 5) { console.log('    ... (truncated)'); break }
      }
    }
    if (!found) console.log(`  "${a} ${b}" [${hex(idA)} ${hex(idB)}]:  not found`)
  }
  console.log()
}

// ── Step 3: Dump a region as composition pairs using real token IDs ────────

function dumpAsComposition(buf, hasHeader, byId, fileStart, dumpLen) {
  const snes = offsetToSnes(fileStart, hasHeader)
  console.log('='.repeat(70))
  console.log(`STEP 3 — Decode region $${hex(fileStart, 6)} (SNES $${hex(snes, 6)}) as composition table`)
  console.log('='.repeat(70))

  const goodNames = []

  for (let off = fileStart; off < fileStart + dumpLen && off + 1 < buf.length; off += 2) {
    const a = buf[off]
    const b = buf[off + 1]
    const ta = byId[a]
    const tb = byId[b]
    const nameA = ta ? ta.text : `?($${hex(a)})`
    const nameB = tb ? tb.text : `?($${hex(b)})`
    const slot = (off - fileStart) / 2
    const line = `  [${String(slot).padStart(3)}]  $${hex(off, 6)}  [${hex(a)} ${hex(b)}]  →  "${nameA} ${nameB}"`
    const isGood = ta && tb
    console.log(line + (isGood ? '' : '  ✗'))
    if (isGood) goodNames.push({ slot, name: `${nameA} ${nameB}` })
  }

  const pct = Math.round(goodNames.length / (dumpLen / 2) * 100)
  console.log(`\n  ${goodNames.length}/${dumpLen/2} entries decoded cleanly (${pct}%).\n`)
  return goodNames
}

// ── Step 4: Scan bank $04 for composition table ────────────────────────────
// The token table is in bank $04. The composition table may be nearby.

function scanBank04(buf, hasHeader, byId) {
  console.log('='.repeat(70))
  console.log('STEP 4 — Scan bank $04 for runs of valid pointer-table IDs')
  console.log('='.repeat(70))
  console.log(`  Valid pointer-table ID range: 0–${byId.length - 1}`)
  console.log()

  // bank $04 LoROM: file offsets $020000+header to $028000+header
  const base = hasHeader ? COPIER_HEADER : 0
  const bank04Start = 4 * 0x8000 + base
  const bank04End   = 5 * 0x8000 + base

  const maxId = byId.length - 1

  for (let off = bank04Start; off < bank04End - 4; off++) {
    let run = 0
    while (off + run < bank04End && buf[off + run] <= maxId) run++
    if (run >= 6) {
      const snes = offsetToSnes(off, hasHeader)
      console.log(`  file $${hex(off, 6)} SNES $${hex(snes, 6)} — ${run} consecutive valid IDs`)
      for (let r = 0; r < Math.min(run, 24); r++) {
        const b = buf[off + r]
        const t = byId[b]
        process.stdout.write(`    [${r.toString().padStart(2)}] $${hex(b)} "${t.text}"\n`)
      }
      if (run > 24) console.log(`    ... ${run - 24} more ...`)
      off += run - 1
      console.log()
    }
  }
}

// ── Step 5: Scan all banks for 2-byte composition runs (96 levels) ─────────

function scanForCompositionTable(buf, hasHeader, byId) {
  console.log('='.repeat(70))
  console.log('STEP 5 — Full ROM scan for 48+ consecutive valid 2-byte composition pairs')
  console.log('='.repeat(70))

  const maxId = byId.length - 1
  const base = hasHeader ? COPIER_HEADER : 0

  // also scan bank $04 and bank $05
  const regions = [
    { name: 'full ROM', start: base, end: buf.length }
  ]

  for (const region of regions) {
    for (let off = region.start; off < region.end - 2; off += 2) {
      let pairs = 0
      while (off + pairs * 2 + 1 < region.end) {
        const a = buf[off + pairs * 2]
        const b = buf[off + pairs * 2 + 1]
        if (a <= maxId && b <= maxId) pairs++
        else break
      }
      if (pairs >= 48) {
        const snes = offsetToSnes(off, hasHeader)
        console.log(`\n  *** file $${hex(off, 6)} SNES $${hex(snes, 6)} — ${pairs} consecutive valid 2-byte pairs ***`)
        for (let p = 0; p < Math.min(pairs, 30); p++) {
          const a = buf[off + p * 2]
          const b = buf[off + p * 2 + 1]
          const ta = byId[a]
          const tb = byId[b]
          const name = `${ta?.text ?? '?'} ${tb?.text ?? '?'}`
          console.log(`    [${p.toString().padStart(2)}]  [${hex(a)} ${hex(b)}]  "${name}"`)
        }
        if (pairs > 30) console.log(`    ... ${pairs - 30} more pairs ...`)
        off += pairs * 2 - 2
      }
    }
  }
  console.log()
}

// ── Entry point ───────────────────────────────────────────────────────────────

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/find-composition-table.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}`)
console.log(`Size: ${buf.length} | Header: ${hasHeader ? 'yes ($200)' : 'no'}\n`)

const byId = buildPointerTable(buf, hasHeader)
searchWithRealIds(buf, hasHeader, byId)
scanBank04(buf, hasHeader, byId)
scanForCompositionTable(buf, hasHeader, byId)

console.log('Done.')
