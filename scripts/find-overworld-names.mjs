/**
 * find-overworld-names.mjs
 *
 * Scans a vanilla SMW ROM for level/area name strings. Four passes:
 *   1. Raw ASCII scan — any printable ASCII runs containing known words
 *   2. Tile-encoded scan — decode SMW overworld font (tile indices → chars)
 *   3. Overworld slot survey — dump the 96 translevel slots with headers
 *   4. Extension bank scan — look for LM-style name tables in upper banks
 *
 * Usage:
 *   node scripts/find-overworld-names.mjs <rom.sfc>
 *   node scripts/find-overworld-names.mjs <rom.sfc> 2>&1 | tee overworld-names-report.txt
 */

import * as fs from 'fs'

// ── ROM loading ───────────────────────────────────────────────────────────────

const COPIER_HEADER = 512

function loadRom(path) {
  const buf = fs.readFileSync(path)
  const hasHeader = (buf.length % 1024) === COPIER_HEADER
  return { buf, hasHeader }
}

function loromToOffset(snesAddr, hasHeader) {
  const bank = (snesAddr >>> 16) & 0xFF
  const addr = snesAddr & 0xFFFF
  const eff  = bank & 0x7F
  let off
  if (eff <= 0x3F) {
    if (addr < 0x8000) return null
    off = eff * 0x8000 + (addr - 0x8000)
  } else if (eff <= 0x6F) {
    off = (eff - 0x40) * 0x10000 + addr
  } else {
    return null
  }
  return off + (hasHeader ? COPIER_HEADER : 0)
}

function offsetToSnes(fileOff, hasHeader) {
  const off = fileOff - (hasHeader ? COPIER_HEADER : 0)
  if (off < 0) return -1
  const bank = Math.floor(off / 0x8000)
  const addr = 0x8000 + (off % 0x8000)
  return (bank << 16) | addr
}

function readBytes(buf, snesAddr, len, hasHeader) {
  const off = loromToOffset(snesAddr, hasHeader)
  if (off === null || off + len > buf.length) return null
  return buf.slice(off, off + len)
}

function hex(n, w) { return n.toString(16).toUpperCase().padStart(w, '0') }

// ── Pass 1 — raw ASCII keyword scan ──────────────────────────────────────────

const ASCII_KEYWORDS = [
  'YOSHI', 'DONUT', 'VANILLA', 'FOREST', 'CHOCOLATE', 'VALLEY',
  'BOWSER', 'BUTTER', 'CHEESE', 'COOKIE', 'SODA', 'STAR',
  'SPECIAL', 'GHOST', 'IGGY', 'MORTON', 'LEMMY', 'ROY',
  'WENDY', 'LARRY', 'LUDWIG', 'PLAINS', 'ILLUSION', 'ISLAND',
  'SWITCH', 'PALACE', 'CASTLE', 'BRIDGE', 'MOUNTAIN', 'SECRET',
  'TUBULAR', 'GNARLY', 'GROOVY', 'MONDO', 'AWESOME', 'FUNKY',
  'OUTRAGEOUS', 'HOUSE',
]

function pass1AsciiScan(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('PASS 1 — Raw ASCII keyword scan')
  console.log('='.repeat(70))

  const hits = []
  for (const kw of ASCII_KEYWORDS) {
    const kwBuf = Buffer.from(kw, 'ascii')
    let pos = 0
    while (true) {
      const idx = buf.indexOf(kwBuf, pos)
      if (idx < 0) break
      hits.push({ off: idx, kw })
      pos = idx + 1
    }
  }

  hits.sort((a, b) => a.off - b.off)

  const shown = new Set()
  let count = 0
  for (const { off, kw } of hits) {
    if ([...shown].some(s => Math.abs(off - s) < 8)) continue
    shown.add(off)
    const snes = offsetToSnes(off, hasHeader)
    const snip = buf.slice(Math.max(0, off - 4), off + 40)
    const printable = [...snip].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
    console.log(`  file $${hex(off,6)}  SNES ~$${hex(snes,6)}  kw=${kw.padEnd(12)}  |${printable}|`)
    count++
  }

  if (count === 0) console.log('  No ASCII keyword hits found.')
  console.log(`\n  ${count} hit region(s).\n`)
}

// ── Pass 2 — tile-encoded text ────────────────────────────────────────────────
//
// SMW overworld message box text uses a tile encoding:
//   $00–$09 = '0'–'9'
//   $0A–$23 = 'A'–'Z'
//   $24 = apostrophe '
//   $25 = '!'   $26 = '.'   $27 = '-'   $28 = ','   $29 = '/'
//   $2A = ':'   $FF = space / terminator
//
// NOTE: This encoding is a working hypothesis based on SMW disassembly
// references. Pass 2 will report where it finds recognisable words.
// If pass 2 finds nothing, the encoding may differ or names may not be
// stored as tile streams.

const TILE_TO_CHAR = new Map([
  ...[...Array(10).keys()].map(i => [i, String(i)]),
  ...[...Array(26).keys()].map(i => [0x0A + i, String.fromCharCode(65 + i)]),
  [0x24, "'"], [0x25, '!'], [0x26, '.'], [0x27, '-'],
  [0x28, ','], [0x29, '/'], [0x2A, ':'], [0xFF, ' '],
])

function decodeTileStr(buf, off, maxLen = 40) {
  const chars = []
  for (let i = 0; i < maxLen && off + i < buf.length; i++) {
    const c = TILE_TO_CHAR.get(buf[off + i])
    if (c === undefined) break
    chars.push(c)
  }
  return chars.join('')
}

const TILE_KEYWORDS = [
  'YOSHI', 'DONUT', 'VANILLA', 'FOREST', 'CHOCOLATE', 'VALLEY',
  'BOWSER', 'ISLAND', 'PLAINS', 'ILLUSION', 'GHOST', 'CASTLE',
  'STAR', 'SPECIAL', 'BUTTER', 'BRIDGE', 'SECRET', 'MOUNTAIN',
  'COOKIE', 'CHEESE', 'SODA', 'SWITCH', 'PALACE', 'TUBULAR',
  'GNARLY', 'GROOVY', 'AWESOME', 'MONDO', 'FUNKY', 'OUTRAGEOUS',
  'HOUSE',
]

function pass2TileScan(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('PASS 2 — Tile-encoded text scan (SMW overworld font hypothesis)')
  console.log('='.repeat(70))

  const base = hasHeader ? COPIER_HEADER : 0
  const hits = []

  for (let off = base; off < buf.length - 6; off++) {
    const decoded = decodeTileStr(buf, off)
    if (decoded.length < 4) continue
    if (TILE_KEYWORDS.some(kw => decoded.includes(kw))) {
      hits.push({ off, decoded })
    }
  }

  const shown = []
  let count = 0
  for (const { off, decoded } of hits) {
    if (shown.some(s => Math.abs(off - s) < 16)) continue
    shown.push(off)
    const snes = offsetToSnes(off, hasHeader)
    const rawBytes = [...buf.slice(off, off + decoded.length + 1)]
      .map(b => hex(b, 2)).join(' ')
    console.log(`  file $${hex(off,6)}  SNES ~$${hex(snes,6)}  "${decoded}"`)
    console.log(`    raw: ${rawBytes}`)
    count++
  }

  if (count === 0) console.log('  No tile-encoded keyword hits found.')
  console.log(`\n  ${count} region(s).\n`)
}

// ── Pass 3 — overworld level slot survey ─────────────────────────────────────

const L1_PTR_BASE   = 0x05E000
const OW_EVENT_BASE = 0x05D608
const OW_EXIT_BASE  = 0x04D678

function transToRoom(tl) { return tl <= 0x24 ? tl : tl + 0xDC }

function pass3OverworldSurvey(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('PASS 3 — Overworld level slot survey (96 translevel slots $00–$5F)')
  console.log('='.repeat(70))
  console.log(`  ${'TL'.padStart(4)}  ${'Room'.padStart(4)}  ${'L1 ptr'.padStart(8)}  B0 B1 B2 B3 B4  ${'EventAssoc'.padStart(10)}  ${'ExitDir'.padStart(7)}`)
  console.log(`  ${''.padStart(4,'-')}  ${''.padStart(4,'-')}  ${''.padStart(8,'-')}  -- -- -- -- --  ${''.padStart(10,'-')}  ${''.padStart(7,'-')}`)

  for (let tl = 0; tl < 0x60; tl++) {
    const room = transToRoom(tl)
    const ptrBytes = readBytes(buf, L1_PTR_BASE + room * 3, 3, hasHeader)
    if (!ptrBytes) { console.log(`  $${hex(tl,2)}   $${hex(room,3)}   [ptr unreadable]`); continue }

    const l1ptr = (ptrBytes[2] << 16) | (ptrBytes[1] << 8) | ptrBytes[0]
    const hdr   = readBytes(buf, l1ptr, 5, hasHeader)
    const b     = hdr ? [...hdr] : [0xFF,0xFF,0xFF,0xFF,0xFF]

    const evB   = readBytes(buf, OW_EVENT_BASE + tl, 1, hasHeader)
    const exB   = readBytes(buf, OW_EXIT_BASE  + tl, 1, hasHeader)

    console.log(
      `  $${hex(tl,2)}   $${hex(room,3)}   $${hex(l1ptr,6)}    ` +
      `${hex(b[0],2)} ${hex(b[1],2)} ${hex(b[2],2)} ${hex(b[3],2)} ${hex(b[4],2)}  ` +
      `${'$'+hex(evB?.[0]??0xFF,2)}            ${'$'+hex(exB?.[0]??0xFF,2)}`
    )
  }
  console.log()
}

// ── Pass 4 — extension/upper bank scan ───────────────────────────────────────

function pass4ExtensionBanks(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('PASS 4 — Extension bank scan (upper banks / LM extended data)')
  console.log('='.repeat(70))

  const base = hasHeader ? COPIER_HEADER : 0
  const romLen = buf.length - base

  let found = 0
  // Scan every bank above the main game area
  for (let bank = 0x10; bank < 0x80; bank++) {
    const fStart = base + bank * 0x8000
    const fEnd   = fStart + 0x8000
    if (fStart >= buf.length) break

    // Find printable ASCII runs ≥ 4 chars
    let runStart = -1
    for (let i = fStart; i <= Math.min(fEnd, buf.length); i++) {
      const isPrint = i < buf.length && buf[i] >= 0x20 && buf[i] < 0x7F
      if (isPrint) {
        if (runStart < 0) runStart = i
      } else {
        if (runStart >= 0 && i - runStart >= 4) {
          const text = buf.slice(runStart, i).toString('ascii')
          if (ASCII_KEYWORDS.some(kw => text.toUpperCase().includes(kw))) {
            const snes = offsetToSnes(runStart, hasHeader)
            console.log(`  Bank $${hex(bank,2)}  file $${hex(runStart,6)}  SNES ~$${hex(snes,6)}  "${text.slice(0,80)}"`)
            found++
          }
        }
        runStart = -1
      }
    }
  }

  if (found === 0) console.log('  No recognisable level-name strings in upper banks.')
  console.log(`\n  ${found} region(s).\n`)
}

// ── Entry point ───────────────────────────────────────────────────────────────

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/find-overworld-names.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}`)
console.log(`Size: ${buf.length} bytes  |  Copier header: ${hasHeader ? 'yes' : 'no'}\n`)

pass1AsciiScan(buf, hasHeader)
pass2TileScan(buf, hasHeader)
pass3OverworldSurvey(buf, hasHeader)
pass4ExtensionBanks(buf, hasHeader)

console.log('Done.')
