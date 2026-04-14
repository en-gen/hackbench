/**
 * Diagnostic: dump parsed objects for a SMW level.
 *
 * Usage:
 *   node scripts/check-level-objects.mjs <path-to-rom.sfc> <level-index-hex>
 *
 * Examples:
 *   node scripts/check-level-objects.mjs rom.sfc 105   # YI 1 (hex 105 = room $105)
 *   node scripts/check-level-objects.mjs rom.sfc 000   # first overworld level
 *
 * Output: raw header bytes, parsed header fields, all objects with type/x/y/param,
 * and a text "map" showing the first 3 screens of the parsed object positions.
 */

import { readFileSync } from 'fs'

const romPath  = process.argv[2]
const levelHex = process.argv[3] ?? '105'

if (!romPath) {
  console.error('Usage: node check-level-objects.mjs <rom.sfc> <level-hex>')
  process.exit(1)
}

const raw      = readFileSync(romPath)
const hasHeader = (raw.length % 1024) === 512
const hdrOff   = hasHeader ? 512 : 0

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

// ── Level L1 pointer ──────────────────────────────────────────────────────────
const LEVEL_L1_PTR = 0x05E000
const index = parseInt(levelHex, 16)

const base = LEVEL_L1_PTR + index * 3
const lo   = readByte(base)
const hi   = readByte(base + 1)
const bk   = readByte(base + 2)

if (lo === null || hi === null || bk === null) {
  console.error(`Level $${levelHex.toUpperCase()}: pointer out of range`)
  process.exit(1)
}

const ptr = (bk << 16) | (hi << 8) | lo
console.log(`Level $${index.toString(16).toUpperCase().padStart(3,'0')}`)
console.log(`L1 pointer: $${ptr.toString(16).toUpperCase().padStart(6,'0')}`)

const data = readAt(ptr, 0x400)
if (!data) {
  console.error('Could not read level data at pointer')
  process.exit(1)
}

// ── Parse header ──────────────────────────────────────────────────────────────
const h = [data[0],data[1],data[2],data[3],data[4]]
const bgPalette    = (h[0] >> 5) & 0x7
const levelLength  =  h[0] & 0x1F
const bgColor      = (h[1] >> 5) & 0x7
const levelMode    =  h[1] & 0x1F
const layer3Prio   = (h[2] >> 7) & 1
const music        = (h[2] >> 4) & 0x7
const spriteSet    =  h[3] & 0xF
const timeLimit    = (h[3] >> 6) & 0x3
const spritePalette= (h[3] >> 4) & 0x3
const itemMemory   = (h[4] >> 6) & 0x3
const vertScroll   = (h[4] >> 4) & 0x3
const bgTypeId     =  h[4] & 0xF
const screens      = levelLength + 1

console.log(`\nRaw header: ${Array.from(h).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`)
console.log(`  screens      = ${screens}  (levelLength=$${levelLength.toString(16)})`)
console.log(`  levelMode    = $${levelMode.toString(16)}  (${levelMode})`)
console.log(`  bgPalette    = ${bgPalette}`)
console.log(`  bgColor      = ${bgColor}`)
console.log(`  music        = $${music.toString(16)}`)
console.log(`  spriteSet    = $${spriteSet.toString(16)}`)
console.log(`  spritePalette= ${spritePalette}`)
console.log(`  timeLimit    = ${timeLimit}`)
console.log(`  bgTypeId     = $${bgTypeId.toString(16)}`)
console.log(`  vertScroll   = ${vertScroll}`)

// ── Parse objects ─────────────────────────────────────────────────────────────
const SCREEN_W = 16

const objects = []
let pos    = 5
let screen = 0

while (pos < data.length) {
  const b0 = data[pos]
  if (b0 === undefined) break

  if (b0 === 0xFF) {
    if (pos + 1 < data.length && data[pos + 1] === 0xFF) {
      screen++
      pos += 2
    } else {
      break  // lone 0xFF = terminator
    }
    continue
  }

  const yNibble = (b0 >> 4) & 0xF

  if (yNibble <= 0x0C) {
    if (pos + 1 >= data.length) break
    const b1 = data[pos + 1]
    objects.push({
      type: 'std',
      screen,
      x: screen * SCREEN_W + (b0 & 0xF),
      y: yNibble,
      objectType: (b1 >> 4) & 0xF,
      param: b1 & 0xF,
      raw: [b0, b1],
      pos,
    })
    pos += 2
  } else {
    if (pos + 2 >= data.length) break
    const b1 = data[pos + 1]
    const b2 = data[pos + 2]
    objects.push({
      type: 'ext',
      screen,
      x: screen * SCREEN_W + (b0 & 0xF),
      y: b1 & 0x3F,
      objectType: 0x100 + b2,
      param: 0,
      raw: [b0, b1, b2],
      pos,
    })
    pos += 3
  }
}

console.log(`\nObjects parsed: ${objects.length}`)
console.log(`Terminator byte at offset ${pos}: 0x${(data[pos] ?? 0xFF).toString(16)}`)
if (pos + 1 <= data.length) {
  console.log(`Next byte:                         0x${(data[pos+1] ?? 0xFF).toString(16)}`)
}

// ── Object list ───────────────────────────────────────────────────────────────
console.log('\n#    offset  type  scrn   x  y  objType  param  raw bytes')
console.log('─'.repeat(70))

for (let i = 0; i < objects.length; i++) {
  const o = objects[i]
  const rawHex = o.raw.map(b => b.toString(16).padStart(2,'0')).join(' ')
  const oType  = o.objectType.toString(16).toUpperCase().padStart(3,'0')
  console.log(
    `${String(i).padStart(3)}  ${String(o.pos).padStart(5)}  ${o.type}   ${String(o.screen).padStart(3)}  ` +
    `${String(o.x).padStart(3)} ${String(o.y).padStart(2)}  $${oType}   ` +
    `${String(o.param).padStart(3)}    ${rawHex}`
  )
}

// ── ASCII map of first 3 screens ──────────────────────────────────────────────
const SCREEN_H = 27
const mapScreens = Math.min(screens, 3)
const cols = mapScreens * SCREEN_W

// Simple grid — mark where objects START (not expanded)
const grid = Array.from({ length: SCREEN_H }, () => new Array(cols).fill('.'))

for (const o of objects) {
  if (o.x < cols && o.y < SCREEN_H) {
    const ch = o.type === 'ext' ? 'E' : o.objectType.toString(16).toUpperCase()
    grid[o.y][o.x] = ch
  }
}

console.log(`\nASCII map (object start positions, first ${mapScreens} screens):`)
console.log('  ' + Array.from({length: cols}, (_,i) => i%16===0 ? '|' : i%4===0 ? '+' : '-').join(''))
for (let r = 0; r < SCREEN_H; r++) {
  console.log(`${String(r).padStart(2)} ${grid[r].join('')}`)
}
console.log('  ' + Array.from({length: cols}, (_,i) => i%16===0 ? '|' : i%4===0 ? '+' : '-').join(''))

// ── Screen separator byte positions ──────────────────────────────────────────
console.log('\nFF FF (screen separator) positions in raw stream:')
let sepCount = 0
for (let i = 5; i < Math.min(pos + 1, data.length - 1); i++) {
  if (data[i] === 0xFF && data[i+1] === 0xFF) {
    console.log(`  offset ${i}: FF FF → screen separator (before screen ${++sepCount})`)
    i++ // skip second 0xFF
  }
}
if (sepCount === 0) console.log('  (none found — single-screen or no separators)')
console.log(`\nTotal: ${sepCount} separators → ${sepCount + 1} screens of object data`)
console.log(`Header says: screens = ${screens}`)
if (sepCount + 1 !== screens) {
  console.log(`⚠ MISMATCH: header says ${screens} screens but object stream has ${sepCount + 1}`)
} else {
  console.log('✓ Screen count matches header')
}
