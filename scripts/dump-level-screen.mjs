/**
 * Dump parsed objects for a specific screen range of a SMW level, using the
 * CURRENT LevelParser semantics (3-byte objects, new-screen flag in byte0 bit 7).
 *
 * Usage:
 *   node scripts/dump-level-screen.mjs <rom> <levelHex> [screenLo] [screenHi]
 */

import { readFileSync } from 'fs'

const romPath  = process.argv[2]
const levelHex = process.argv[3] ?? '105'
const sLo = parseInt(process.argv[4] ?? '0', 16)
const sHi = parseInt(process.argv[5] ?? 'FF', 16)

const raw = readFileSync(romPath)
const hdrOff = (raw.length % 1024) === 512 ? 512 : 0

function off(snes) {
  const b = (snes >>> 16) & 0xFF
  const a = snes & 0xFFFF
  return hdrOff + (b & 0x7F) * 0x8000 + (a - 0x8000)
}
const rd = (s) => raw[off(s)]

const idx = parseInt(levelHex, 16)
const base = 0x05E000 + idx * 3
const ptr = (rd(base + 2) << 16) | (rd(base + 1) << 8) | rd(base)
console.log(`Level $${idx.toString(16).toUpperCase()} L1=$${ptr.toString(16).toUpperCase()}`)

const data = raw.subarray(off(ptr), off(ptr) + 0x800)
const h = [data[0],data[1],data[2],data[3],data[4]]
const screens = (h[0] & 0x1F) + 1
console.log(`Header ${h.map(b=>b.toString(16).padStart(2,'0')).join(' ')} screens=${screens}`)

// 3-byte object parser matching src/rom/LevelParser.ts
let pos = 5
let screen = 0
const objects = []
while (pos < data.length) {
  const b0 = data[pos]
  if (b0 === 0xFF) break
  if (pos + 2 >= data.length) break
  const b1 = data[pos + 1]
  const b2 = data[pos + 2]
  pos += 3

  const newScreen = (b0 & 0x80) !== 0
  if (newScreen) screen++
  const highCoord = (b0 & 0x10) !== 0
  const objNumHigh = (b0 & 0x60) >> 1
  const objNumLow  = (b1 >> 4) & 0x0F
  const objectNumber = objNumLow | objNumHigh
  const yLocal = (b0 & 0x0F) + (highCoord ? 16 : 0)
  const xLocal = b1 & 0x0F
  const isExt = objectNumber === 0

  // Screen exit consumes extra byte
  if (isExt && b2 === 0 && pos < data.length) pos += 1

  objects.push({
    type: isExt ? 'ext' : 'std',
    screen,
    xLocal,
    yLocal,
    objNum: isExt ? b2 : objectNumber,
    settings: b2,
    newScreen, highCoord,
    raw: [b0, b1, b2],
  })

  // Ext $01 = CODE_0DA53D: overwrites screen counter with b0 & 0x1F
  if (isExt && b2 === 0x01) screen = b0 & 0x1F
}

console.log(`\n# obj screen xLocal yLocal   kind  objNum  size  NS HC  raw`)
console.log('─'.repeat(80))
for (let i = 0; i < objects.length; i++) {
  const o = objects[i]
  if (o.screen < sLo || o.screen > sHi) continue
  const objStr = o.type === 'ext' ? `ext $${o.objNum.toString(16).padStart(2,'0')}` : `std $${o.objNum.toString(16).padStart(2,'0')}`
  console.log(
    `${String(i).padStart(3)}  ${String(o.screen).padStart(2)}(0x${o.screen.toString(16).padStart(2,'0')}) ` +
    `   ${String(o.xLocal).padStart(2)}     ${String(o.yLocal).padStart(2)}   ` +
    `${objStr.padEnd(10)}  size=${String(o.settings).padStart(3)}  ` +
    `${o.newScreen ? 'NS' : '  '} ${o.highCoord ? 'HC' : '  '}  ` +
    `${o.raw.map(b => b.toString(16).padStart(2,'0')).join(' ')}`
  )
}
