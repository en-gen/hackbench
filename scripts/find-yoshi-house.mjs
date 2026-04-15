/**
 * find-yoshi-house.mjs
 *
 * Brute-force search for "YOSHI'S HOUSE" in a vanilla SMW ROM.
 *
 * Strategy:
 *   1. Try every possible tile-encoding offset for 'A' (0x00–0x7F) and
 *      see if "YOSHI" appears under that encoding anywhere in the ROM.
 *   2. Try every possible byte stride (1, 2, 4) in case the string is
 *      stored interleaved with other data.
 *   3. Search for the raw byte patterns of likely VRAM tile indices
 *      based on known disassembly references.
 *   4. Decompress any LC_LZ2-encoded blocks and search those too.
 *
 * Usage:
 *   node scripts/find-yoshi-house.mjs <rom.sfc>
 */

import * as fs from 'fs'

const COPIER_HEADER = 512

function loadRom(path) {
  const buf = fs.readFileSync(path)
  const hasHeader = (buf.length % 1024) === COPIER_HEADER
  return { buf, hasHeader }
}

function hex(n, w = 6) { return n.toString(16).toUpperCase().padStart(w, '0') }

// ---------------------------------------------------------------------------
// Strategy 1: Brute-force tile encoding for 'A' offset
//
// If 'A' maps to tile T, then Y=T+24, O=T+14, S=T+18, H=T+7, I=T+8
// We try every T from 0x00 to 0x7F and search the ROM for the resulting
// byte pattern.
// ---------------------------------------------------------------------------

function strategy1BruteForceEncoding(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('STRATEGY 1 — Brute-force tile encoding for "YOSHI\'S HOUSE"')
  console.log('='.repeat(70))

  const base = hasHeader ? COPIER_HEADER : 0

  // Target: YOSHI (5 bytes), with unknown encoding base for 'A'
  // Y=A+24, O=A+14, S=A+18, H=A+7, I=A+8
  let found = 0

  for (let aBase = 0; aBase <= 0xFF; aBase++) {
    const Y = (aBase + 24) & 0xFF
    const O = (aBase + 14) & 0xFF
    const S = (aBase + 18) & 0xFF
    const H = (aBase +  7) & 0xFF
    const I = (aBase +  8) & 0xFF

    // Search for YOSHI as a contiguous 5-byte run
    let pos = base
    while (pos < buf.length - 5) {
      if (buf[pos] === Y && buf[pos+1] === O && buf[pos+2] === S &&
          buf[pos+3] === H && buf[pos+4] === I) {

        // What follows? Decode surrounding bytes with this encoding
        const decoded = []
        for (let i = pos; i < Math.min(pos + 30, buf.length); i++) {
          const code = buf[i] - aBase
          if (code >= 0 && code < 26) decoded.push(String.fromCharCode(65 + code))
          else if (buf[i] === 0xFF) decoded.push(' ')
          else decoded.push(`[${hex(buf[i],2)}]`)
        }

        console.log(`  Hit! 'A' base=$${hex(aBase,2)}  file=$${hex(pos)}`)
        console.log(`    Decoded: "${decoded.join('')}"`)
        const rawBytes = [...buf.slice(pos, pos+20)].map(b => hex(b,2)).join(' ')
        console.log(`    Raw:      ${rawBytes}`)
        found++
      }
      pos++
    }
  }

  if (found === 0) console.log('  No "YOSHI" sequence found under any encoding base 0x00–0xFF.')
  console.log()
}

// ---------------------------------------------------------------------------
// Strategy 2: Stride search — string bytes interleaved every N bytes
//
// Some SNES games store text in attribute/tile pairs (2-byte stride).
// E.g., bytes at even offsets = tile, odd offsets = palette/attribute.
// ---------------------------------------------------------------------------

function strategy2StrideSearch(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('STRATEGY 2 — Interleaved/strided "YOSHI" search (stride 2, 4)')
  console.log('='.repeat(70))

  const base = hasHeader ? COPIER_HEADER : 0
  let found = 0

  for (const stride of [2, 4]) {
    for (let aBase = 0; aBase <= 0xFF; aBase++) {
      const Y = (aBase + 24) & 0xFF
      const O = (aBase + 14) & 0xFF
      const S = (aBase + 18) & 0xFF
      const H = (aBase +  7) & 0xFF
      const I = (aBase +  8) & 0xFF

      for (let pos = base; pos < buf.length - 5*stride; pos++) {
        if (buf[pos]          === Y &&
            buf[pos + stride] === O &&
            buf[pos+2*stride] === S &&
            buf[pos+3*stride] === H &&
            buf[pos+4*stride] === I) {

          console.log(`  Hit! stride=${stride} 'A'=$${hex(aBase,2)} file=$${hex(pos)}`)
          const raw = []
          for (let i = 0; i < 8; i++) raw.push(hex(buf[pos + i*stride] ?? 0, 2))
          console.log(`    Strided bytes: ${raw.join(' ')}`)
          found++
        }
      }
    }
  }

  if (found === 0) console.log('  No hits at stride 2 or 4 with any encoding.')
  console.log()
}

// ---------------------------------------------------------------------------
// Strategy 3: LC_LZ2 decompression + scan
//
// SMW compresses overworld tilemap, sprite, and other data with LC_LZ2.
// Decompress each block found by scanning for the compression header
// pattern, then search the decompressed data.
//
// LC_LZ2 header: reads a command byte, high 3 bits = type, low 5 = length-1.
// This is a heuristic decompressor — it attempts to decompress every
// 512-byte aligned block and checks if the result contains "YOSHI".
// ---------------------------------------------------------------------------

function lc_lz2_decompress(rom, startOffset) {
  const out = []
  let i = startOffset

  try {
    while (i < rom.length && out.length < 0x10000) {
      const cmd = rom[i++]
      if (cmd === 0xFF) break  // terminator

      const type = (cmd >> 5) & 0x07
      let len = (cmd & 0x1F) + 1

      if (type === 7) {
        // Extended command: next byte gives extra type bits
        const cmd2 = rom[i++]
        const extType = ((cmd >> 2) & 0x07)
        len = ((cmd & 0x03) << 8) | cmd2 + 1
        // simplified — treat as extended fill/copy
      }

      switch (type) {
        case 0: // Direct copy
          for (let j = 0; j < len && i < rom.length; j++) out.push(rom[i++])
          break
        case 1: // Byte fill
          { const val = rom[i++]; for (let j = 0; j < len; j++) out.push(val) }
          break
        case 2: // Word fill
          { const lo = rom[i++]; const hi = rom[i++]
            for (let j = 0; j < len; j++) out.push(j % 2 === 0 ? lo : hi) }
          break
        case 3: // Zero fill
          for (let j = 0; j < len; j++) out.push(0)
          break
        case 4: // Sliding window (backward ref from current pos)
          { const hi = rom[i++]; const lo = rom[i++]
            const src = (hi << 8) | lo
            for (let j = 0; j < len; j++) out.push(out[src + j] ?? 0) }
          break
        case 5: // Sliding window (offset from output start)
          { const src = ((rom[i] << 8) | rom[i+1]); i += 2
            for (let j = 0; j < len; j++) out.push(out[src + j] ?? 0) }
          break
        case 6: // Flip bits copy
          for (let j = 0; j < len && i < rom.length; j++) {
            const b = rom[i++]
            out.push(((b & 1) << 7)|((b & 2) << 5)|((b & 4) << 3)|((b & 8) << 1)|
                     ((b & 16) >> 1)|((b & 32) >> 3)|((b & 64) >> 5)|((b & 128) >> 7))
          }
          break
        default:
          return null  // unknown type, abort
      }
    }
  } catch (e) {
    return null
  }

  return out.length > 8 ? Buffer.from(out) : null
}

function strategy3LZ2Scan(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('STRATEGY 3 — LC_LZ2 decompress-and-scan')
  console.log('='.repeat(70))
  console.log('  Attempting decompression at all 256-byte-aligned offsets...')

  const base = hasHeader ? COPIER_HEADER : 0
  let tried = 0, found = 0

  for (let off = base; off < buf.length - 16; off += 256) {
    const decompressed = lc_lz2_decompress(buf, off)
    if (!decompressed || decompressed.length < 32) continue
    tried++

    // Search decompressed output for YOSHI under all encodings
    for (let aBase = 0; aBase <= 0xFF; aBase++) {
      const Y = (aBase + 24) & 0xFF
      const O = (aBase + 14) & 0xFF
      const S = (aBase + 18) & 0xFF
      const H = (aBase +  7) & 0xFF
      const I = (aBase +  8) & 0xFF

      for (let p = 0; p < decompressed.length - 5; p++) {
        if (decompressed[p]   === Y && decompressed[p+1] === O &&
            decompressed[p+2] === S && decompressed[p+3] === H &&
            decompressed[p+4] === I) {

          console.log(`  Hit in decompressed block at ROM $${hex(off)}!`)
          console.log(`    Decompressed offset: $${hex(p,4)}  encoding 'A'=$${hex(aBase,2)}`)
          const raw = [...decompressed.slice(p, p+15)].map(b => hex(b,2)).join(' ')
          console.log(`    Decompressed bytes: ${raw}`)
          found++
          aBase = 0x100  // stop inner loop for this block
          break
        }
      }
    }
  }

  console.log(`  Tried ${tried} potential LZ2 blocks. Found ${found} YOSHI hit(s).\n`)
}

// ---------------------------------------------------------------------------
// Strategy 4: Search specifically for the SMW overworld message data
//
// Known from SMW disassembly: overworld level name display uses a table
// at around $00A2EA in the ROM (various disassembly references).
// Also try searching the "Overworld Init" bank ($04) for name pointer tables.
// ---------------------------------------------------------------------------

function strategy4KnownAddresses(buf, hasHeader) {
  console.log('='.repeat(70))
  console.log('STRATEGY 4 — Dump candidate ROM regions for manual inspection')
  console.log('='.repeat(70))

  function loromOff(snes) {
    const bank = (snes >>> 16) & 0x7F
    const addr = snes & 0xFFFF
    if (addr < 0x8000) return null
    const off = bank * 0x8000 + (addr - 0x8000) + (hasHeader ? COPIER_HEADER : 0)
    return off < buf.length ? off : null
  }

  // Candidate address regions from SMW disassembly notes
  // and community documentation for overworld title display.
  const candidates = [
    { name: 'Overworld course-name data (commonly cited $A2EA)', snes: 0x00A2EA, len: 0x200 },
    { name: 'Near ROM name string $FFC0 (internal header)',       snes: 0x00FFC0, len: 0x40  },
    { name: 'OW event assoc base $05D608',                        snes: 0x05D608, len: 0x80  },
    { name: 'Bank $04 area $4D678 exit dirs',                     snes: 0x04D678, len: 0x80  },
    { name: 'Near $009EE0 initial flags',                         snes: 0x009EE0, len: 0x80  },
  ]

  for (const { name, snes, len } of candidates) {
    const off = loromOff(snes)
    if (off === null) { console.log(`  ${name}: [out of range]`); continue }
    const region = buf.slice(off, off + len)
    const hexDump = [...region].map(b => hex(b,2)).join(' ')
    const ascii   = [...region].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
    console.log(`\n  ${name}`)
    console.log(`  SNES $${hex(snes)}  file $${hex(off)}`)
    console.log(`  Hex:   ${hexDump.slice(0, 120)}${hexDump.length > 120 ? '…' : ''}`)
    console.log(`  ASCII: ${ascii.slice(0, 60)}`)
  }

  // Now dump the first 64 bytes of every bank in the $04–$08 range as a
  // heuristic — the name data is likely in one of the overworld-related banks.
  console.log('\n  --- First 32 bytes of each bank $04–$08 (page $8000) ---')
  for (let bank = 0x04; bank <= 0x08; bank++) {
    const off = bank * 0x8000 + (hasHeader ? COPIER_HEADER : 0)
    if (off >= buf.length) break
    const region = buf.slice(off, off + 32)
    const h = [...region].map(b => hex(b,2)).join(' ')
    const a = [...region].map(b => (b >= 0x20 && b < 0x7F) ? String.fromCharCode(b) : '.').join('')
    console.log(`  Bank $${hex(bank,2)} off $${hex(off)}: ${h}  |${a}|`)
  }
  console.log()
}

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/find-yoshi-house.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}`)
console.log(`Size: ${buf.length} bytes  |  Copier header: ${hasHeader ? 'yes' : 'no'}\n`)

strategy1BruteForceEncoding(buf, hasHeader)
strategy2StrideSearch(buf, hasHeader)
strategy3LZ2Scan(buf, hasHeader)
strategy4KnownAddresses(buf, hasHeader)

console.log('Done.')
