/**
 * Decompress every GFX file in a SMW ROM and report decompressed sizes.
 *
 * Usage:
 *   node scripts/check-gfx-decompress.mjs <path-to-rom.sfc>
 *
 * Expected output for a vanilla ROM:
 *   Most files: 4096 bytes (128 tiles × 32 bytes, 4bpp)
 *   GFX20 hex (index 32): 1536 bytes (64 tiles × 24 bytes, 3bpp)
 *   Any other size is suspicious and may indicate a decompressor bug or
 *   a file that is genuinely smaller (partial sheet).
 */

import { readFileSync } from 'fs'

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node check-gfx-decompress.mjs <path-to-rom.sfc>')
  process.exit(1)
}

const raw = readFileSync(romPath)
const hasHeader = (raw.length % 1024) === 512
const hdrOff    = hasHeader ? 512 : 0
console.log(`ROM: ${raw.length} bytes, SMC header: ${hasHeader}\n`)

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

// ── LC_LZ2 decompressor (mirrors the TypeScript implementation) ───────────────
function decompress(src, srcOffset = 0) {
  const out = []
  let i = srcOffset

  while (i < src.length) {
    const header = src[i++]
    if (header === 0xFF) break

    let cmd = (header >> 5) & 7
    let len

    if (cmd === 7) {
      if (i >= src.length) break
      const ext = src[i++]
      cmd = (header >> 2) & 7
      len = ((header & 3) << 8 | ext) + 1
    } else {
      len = (header & 0x1F) + 1
    }

    switch (cmd) {
      case 0: {
        for (let n = 0; n < len && i < src.length; n++) out.push(src[i++])
        break
      }
      case 1: {
        if (i >= src.length) break
        const b = src[i++]
        for (let n = 0; n < len; n++) out.push(b)
        break
      }
      case 2: {
        if (i + 1 >= src.length) break
        const b0 = src[i++]
        const b1 = src[i++]
        for (let n = 0; n < len; n++) out.push(n % 2 === 0 ? b0 : b1)
        break
      }
      case 3: {
        if (i >= src.length) break
        let b = src[i++]
        for (let n = 0; n < len; n++) out.push(b++ & 0xFF)
        break
      }
      case 4: {
        if (i + 1 >= src.length) break
        const addrHi = src[i++]
        const addrLo = src[i++]
        const addr   = (addrHi << 8) | addrLo
        for (let n = 0; n < len; n++) out.push(addr + n < out.length ? out[addr + n] : 0)
        break
      }
      default:
        break
    }
  }

  return Uint8Array.from(out)
}

// ── GFX pointer tables ────────────────────────────────────────────────────────
const GFX_PTR_LO   = 0x00B992
const GFX_PTR_HI   = 0x00B9C4
const GFX_PTR_BANK = 0x00B9F6
const GFX_FILE_COUNT = 50  // GFX00–GFX31 hex (indices 0–49 decimal)
const GFX_MARIO_3BPP_INDEX = 32  // GFX20 hex
const GFX_MAX_COMPRESSED   = 0x2000

console.log('Idx  HEX  SNES Addr    Decomp bytes  Tiles(4bpp)  Tiles(3bpp)  Status')
console.log('─'.repeat(76))

let totalOk = 0
let totalBad = 0

for (let i = 0; i < GFX_FILE_COUNT; i++) {
  const lo   = readByte(GFX_PTR_LO   + i)
  const hi   = readByte(GFX_PTR_HI   + i)
  const bank = readByte(GFX_PTR_BANK + i)

  if (lo === null || hi === null || bank === null) {
    console.log(`${String(i).padStart(3)}  ${i.toString(16).toUpperCase().padStart(2,'0')}   (out of range)`)
    totalBad++
    continue
  }

  const snesAddr = (bank << 16) | (hi << 8) | lo
  const hexName  = i.toString(16).toUpperCase().padStart(2, '0')
  const addrStr  = `$${snesAddr.toString(16).toUpperCase().padStart(6, '0')}`

  const compressed = readAt(snesAddr, GFX_MAX_COMPRESSED)
  if (!compressed) {
    console.log(`${String(i).padStart(3)}  ${hexName}   ${addrStr}   (no data at pointer)`)
    totalBad++
    continue
  }

  const decompressed = decompress(compressed)
  const byteCount = decompressed.length
  const tiles4bpp  = Math.floor(byteCount / 32)
  const tiles3bpp  = Math.floor(byteCount / 24)
  const is3bpp     = i === GFX_MARIO_3BPP_INDEX

  let status = ''
  if (is3bpp) {
    status = tiles3bpp === 64 ? 'OK (3bpp, 64 tiles)' : `⚠ 3bpp: expected 64, got ${tiles3bpp} tiles`
  } else {
    if (byteCount === 4096) {
      status = 'OK'
      totalOk++
    } else if (byteCount % 32 === 0 && tiles4bpp > 0) {
      status = `⚠ short: ${tiles4bpp} tiles (expected 128)`
      totalBad++
    } else {
      status = `⚠ odd size: ${byteCount} bytes`
      totalBad++
    }
  }

  console.log(
    `${String(i).padStart(3)}  ${hexName}   ${addrStr}   ` +
    `${String(byteCount).padStart(5)} bytes   ` +
    `${String(tiles4bpp).padStart(5)}        ` +
    `${String(tiles3bpp).padStart(5)}       ` +
    status
  )
}

console.log(`\nSummary: ${totalOk} full-size, ${totalBad} short/bad (of ${GFX_FILE_COUNT} files)`)

// ── Spot-check: show first 32 bytes of decompressed GFX08 ─────────────────────
console.log('\n── GFX08 hex (index 8) first 64 decompressed bytes ────────────────')
{
  const lo   = readByte(GFX_PTR_LO   + 8)
  const hi   = readByte(GFX_PTR_HI   + 8)
  const bank = readByte(GFX_PTR_BANK + 8)
  const snesAddr = (bank << 16) | (hi << 8) | lo
  const compressed   = readAt(snesAddr, GFX_MAX_COMPRESSED)
  const decompressed = decompress(compressed)
  console.log(`Decompressed: ${decompressed.length} bytes = ${Math.floor(decompressed.length/32)} tiles (4bpp)`)
  for (let row = 0; row < Math.min(4, Math.ceil(decompressed.length/16)); row++) {
    const bytes = Array.from(decompressed.subarray(row*16, row*16+16))
      .map(b => b.toString(16).padStart(2, '0')).join(' ')
    console.log(`  [${String(row*16).padStart(4)}] ${bytes}`)
  }
}

// ── Spot-check: what byte terminates GFX08 compressed stream? ─────────────────
console.log('\n── GFX08 hex compressed stream analysis ───────────────────────────')
{
  const lo   = readByte(GFX_PTR_LO   + 8)
  const hi   = readByte(GFX_PTR_HI   + 8)
  const bank = readByte(GFX_PTR_BANK + 8)
  const snesAddr = (bank << 16) | (hi << 8) | lo
  const src  = readAt(snesAddr, GFX_MAX_COMPRESSED)

  // Walk the stream manually, counting bytes consumed
  const out = []
  let i = 0
  let cmdCount = 0

  while (i < src.length) {
    const header = src[i]
    if (header === 0xFF) {
      console.log(`  Terminator 0xFF at compressed offset ${i}, output = ${out.length} bytes`)
      break
    }

    let cmd = (header >> 5) & 7
    let len, dataStart = i + 1, dataCost = 0

    if (cmd === 7) {
      const ext = src[i+1] ?? 0
      cmd = (header >> 2) & 7
      len = ((header & 3) << 8 | ext) + 1
      dataCost = (cmd === 0 ? len : cmd === 2 ? 2 : 1)
      i += 2 + dataCost
    } else {
      len = (header & 0x1F) + 1
      dataCost = (cmd === 0 ? len : cmd === 2 ? 2 : cmd === 4 ? 2 : cmd === 0 ? len : 1)
      // Adjust for cmd 1,3: 1 data byte; cmd 2,4: 2 data bytes; cmd 0: len data bytes
      switch (cmd) {
        case 0: dataCost = len; break
        case 1: dataCost = 1;   break
        case 2: dataCost = 2;   break
        case 3: dataCost = 1;   break
        case 4: dataCost = 2;   break
        default: dataCost = 0;  break
      }
      i += 1 + dataCost
    }

    cmdCount++
    for (let n = 0; n < len; n++) out.push(0) // fake output to track size

    if (cmdCount <= 5 || out.length > 3000) {
      if (cmdCount <= 5) {
        console.log(`  cmd[${cmdCount}] hdr=0x${header.toString(16).padStart(2,'0')} type=${cmd} len=${len} → out size now ${out.length}`)
      }
      if (out.length >= 3072 && out.length <= 3200) {
        console.log(`  *** Around 96-tile mark (3072 bytes): out=${out.length}, compressed offset=${i}`)
      }
    }
  }
  if (i >= src.length) {
    console.log(`  Stream ended without 0xFF terminator at compressed offset ${i}, output = ${out.length} bytes`)
  }
}
