/**
 * Diagnostic: dump Map16 tile data for specific tile IDs.
 *
 * Shows the four subtile char numbers and palette rows for each
 * Map16 tile used by the ObjectExpander. This lets us verify:
 *  1. The tile IDs we're using are correct
 *  2. The charNums are in the expected VRAM ranges
 *  3. The palette rows make sense for the tile type
 *
 * Usage:
 *   node scripts/check-map16-tiles.mjs <path-to-rom.sfc>
 */

import { readFileSync } from 'fs'

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node check-map16-tiles.mjs <rom.sfc>')
  process.exit(1)
}

const raw = readFileSync(romPath)
const hasHeader = (raw.length % 1024) === 512
const hdrOff    = hasHeader ? 512 : 0

// ── LoROM ─────────────────────────────────────────────────────────────────────
function loromToOffset(snesAddr) {
  const bank        = (snesAddr >>> 16) & 0xFF
  const addr        = snesAddr & 0xFFFF
  const effectiveBank = bank & 0x7F
  if (effectiveBank > 0x3F) return null
  if (addr < 0x8000) return null
  return hdrOff + effectiveBank * 0x8000 + (addr - 0x8000)
}

function readWord(snesAddr) {
  const off = loromToOffset(snesAddr)
  if (off === null || off + 2 > raw.length) return null
  return raw[off] | (raw[off + 1] << 8)
}

// ── Map16 ─────────────────────────────────────────────────────────────────────
const MAP16_PAGE0 = 0x0D8000  // tiles $000–$0FF
const MAP16_PAGE1 = 0x0DC000  // tiles $100–$1FF

function readMap16Tile(id) {
  const base = id < 0x100 ? MAP16_PAGE0 : MAP16_PAGE1
  const index = id & 0xFF
  const addr = base + index * 8

  const w0 = readWord(addr)
  const w1 = readWord(addr + 2)
  const w2 = readWord(addr + 4)
  const w3 = readWord(addr + 6)

  const dec = (w) => w === null ? null : {
    charNum: w & 0x3FF,
    palette: (w >> 10) & 0x7,
    prio:    (w >> 13) & 1,
    flipX:   (w >> 14) & 1,
    flipY:   (w >> 15) & 1,
  }

  // SNES column-major order: TL, BL, TR, BR
  return { id, tl: dec(w0), bl: dec(w1), tr: dec(w2), br: dec(w3) }
}

function subStr(s) {
  if (!s) return '----'
  const flip = (s.flipX ? 'x' : '') + (s.flipY ? 'y' : '')
  return `$${s.charNum.toString(16).padStart(3,'0')} pal${s.palette}${flip ? '['+flip+']' : ''}`
}

// ── VRAM char range names (approximate) ──────────────────────────────────────
// Based on VRAM_CHAR_BASE from GfxLoader.ts:
//   fg1: $000-$05F (96 tiles)   fg2: $080-$0DF   fg3: $100-$15F
//   an1: $180-$1DF              an2: $200-$25F   bg1: $280-$2DF
function vramSlot(charNum) {
  if (charNum >= 0x000 && charNum < 0x060) return 'fg1'
  if (charNum >= 0x080 && charNum < 0x0E0) return 'fg2'
  if (charNum >= 0x100 && charNum < 0x160) return 'fg3'
  if (charNum >= 0x180 && charNum < 0x1E0) return 'an1'
  if (charNum >= 0x200 && charNum < 0x260) return 'an2(3bpp)'
  if (charNum >= 0x280 && charNum < 0x2E0) return 'bg1'
  if (charNum >= 0x060 && charNum < 0x080) return 'fg1-BLANK'
  return `$${charNum.toString(16)}`
}

// ── Tiles to check ────────────────────────────────────────────────────────────
// These are the tile IDs used by ObjectExpander.ts
const TILE_IDS_TO_CHECK = [
  // Ground tiles (our IDs — ⚠ verify)
  { id: 0x054, label: 'GROUND_TL (top-left ground corner)' },
  { id: 0x055, label: 'GROUND_TM (top-middle ground)' },
  { id: 0x056, label: 'GROUND_TR (top-right ground corner)' },
  { id: 0x074, label: 'GROUND_ML (middle-left ground)' },
  { id: 0x075, label: 'GROUND_MM (middle ground fill)' },
  { id: 0x076, label: 'GROUND_MR (middle-right ground)' },
  { id: 0x094, label: 'GROUND_BL (bottom-left ground corner)' },
  { id: 0x095, label: 'GROUND_BM (bottom-middle ground)' },
  { id: 0x096, label: 'GROUND_BR (bottom-right ground corner)' },
  // Blocks
  { id: 0x012, label: 'CEMENT block' },
  { id: 0x011, label: 'BRICK block' },
  { id: 0x010, label: '? BLOCK' },
  { id: 0x001, label: 'COIN' },
  { id: 0x07F, label: 'MUNCHER' },
  // Pipe
  { id: 0x10A, label: 'PIPE top-left' },
  { id: 0x10B, label: 'PIPE top-right' },
  { id: 0x108, label: 'PIPE body-left' },
  { id: 0x109, label: 'PIPE body-right' },
]

// Also dump a range for context: tiles $050-$060 and $000-$015
const RANGE_IDS = [
  ...Array.from({length: 0x10}, (_,i) => ({ id: 0x000 + i, label: '' })),
  ...Array.from({length: 0x10}, (_,i) => ({ id: 0x050 + i, label: '' })),
  ...Array.from({length: 0x10}, (_,i) => ({ id: 0x100 + i, label: '' })),
]

console.log('=== Map16 Tiles Used by ObjectExpander ===\n')
console.log('ID     TL                BL                TR                BR                label')
console.log('─'.repeat(100))

for (const { id, label } of TILE_IDS_TO_CHECK) {
  const t = readMap16Tile(id)
  const tlS = subStr(t.tl)
  const blS = subStr(t.bl)
  const trS = subStr(t.tr)
  const brS = subStr(t.br)
  const warn = [t.tl, t.bl, t.tr, t.br].some(s => s && s.charNum === 0) ? ' ← has $000 char' : ''
  console.log(
    `$${id.toString(16).toUpperCase().padStart(3,'0')}   ${tlS.padEnd(16)} ${blS.padEnd(16)} ${trS.padEnd(16)} ${brS.padEnd(16)}  ${label}${warn}`
  )
}

console.log('\n=== Map16 Range Dump ===\n')
console.log('ID     TL              BL              TR              BR')
console.log('─'.repeat(80))
for (const { id } of RANGE_IDS) {
  const t = readMap16Tile(id)
  const tlS = t.tl ? `$${t.tl.charNum.toString(16).padStart(3,'0')} p${t.tl.palette} [${vramSlot(t.tl.charNum)}]` : '----'
  const blS = t.bl ? `$${t.bl.charNum.toString(16).padStart(3,'0')} p${t.bl.palette} [${vramSlot(t.bl.charNum)}]` : '----'
  const trS = t.tr ? `$${t.tr.charNum.toString(16).padStart(3,'0')} p${t.tr.palette} [${vramSlot(t.tr.charNum)}]` : '----'
  const brS = t.br ? `$${t.br.charNum.toString(16).padStart(3,'0')} p${t.br.palette} [${vramSlot(t.br.charNum)}]` : '----'
  console.log(`$${id.toString(16).toUpperCase().padStart(3,'0')}   ${tlS.padEnd(20)} ${blS.padEnd(20)} ${trS.padEnd(20)} ${brS}`)
}

// ── Also show what tiles map to expected ground chars ─────────────────────────
console.log('\n=== Search: which Map16 IDs use charNums in fg1 range ($000-$05F)? ===')
console.log('(These are the tiles that would show actual FG terrain graphics)\n')

const interesting = []
for (let id = 0; id < 0x200; id++) {
  const t = readMap16Tile(id)
  const subs = [t.tl, t.bl, t.tr, t.br]
  const usedFg1 = subs.filter(s => s && s.charNum >= 0x000 && s.charNum < 0x060 && s.charNum !== 0)
  if (usedFg1.length > 0) {
    const chars = subs.filter(s=>s&&s.charNum!==0).map(s=>`$${s.charNum.toString(16)}`).join(',')
    interesting.push({ id, chars })
  }
}

console.log(`Found ${interesting.length} tiles using fg1 range ($000-$05F)`)
for (const { id, chars } of interesting.slice(0, 30)) {
  console.log(`  $${id.toString(16).padStart(3,'0')}  chars: ${chars}`)
}
if (interesting.length > 30) console.log(`  ... and ${interesting.length - 30} more`)
