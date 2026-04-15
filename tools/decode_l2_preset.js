#!/usr/bin/env node
/**
 * decode_l2_preset.js — probe the L2 preset format for a given level.
 *
 * Usage:  node tools/decode_l2_preset.js [levelIndex]
 *   levelIndex: decimal or hex (prefix 0x). Default: 260 (= $104, Yoshi's House)
 *
 * The script:
 *   1. Reads the L2 pointer for the level (must have bank=$FF for a preset level)
 *   2. Dumps the first 64 raw bytes at the preset address
 *   3. Tries several decompression/decoding strategies and reports the output length
 *      and first few decoded words for each
 *
 * Strategies tested:
 *   A. Raw words — treat bytes directly as SNES BG2 tilemap (current broken approach)
 *   B. LC_LZ2   — run the existing decompress() and see if output is plausible
 *   C. Word-RLE — simple format: [tile-word][run-word] pairs until $FFFF terminator
 *   D. Byte-RLE — [count][lo][hi] triples until FF FF FF terminator
 *
 * Compare the decoded charNums from each strategy against the known-good charNum set
 * from the Mesen VRAM dump (vram-analysis.md):
 *   Valid charNums for level $104 BG2: $000–$159 (fg1/fg2/fg3 slots)
 *
 * A strategy is "plausible" if ≥80% of decoded charNums fall in $000–$159.
 */

'use strict'

const fs = require('fs')
const path = require('path')

// ── Config ────────────────────────────────────────────────────────────────────
const ROM_PATH = path.join(__dirname, '../test/roms/Super Mario World (USA).sfc')

// Known-good charNum set from vram-analysis.md BG2 tilemap
const VALID_CHAR_SET = new Set([
  0x000, 0x010, 0x011, 0x018, 0x020, 0x03c, 0x03d, 0x03f, 0x040, 0x042, 0x043,
  0x045, 0x046, 0x047, 0x048, 0x04f, 0x050, 0x058, 0x05d, 0x068, 0x069, 0x06c,
  0x06d, 0x06e, 0x071, 0x075, 0x085, 0x086, 0x087, 0x088, 0x089, 0x095, 0x096,
  0x097, 0x099, 0x0b8, 0x0b9, 0x0d8, 0x0d9, 0x0f8, 0x0f9, 0x0fc, 0x0ff,
  0x100, 0x101, 0x102, 0x103, 0x104, 0x105, 0x106, 0x107, 0x108, 0x109, 0x10a,
  0x10b, 0x10c, 0x10d, 0x10e, 0x10f, 0x110, 0x111, 0x112, 0x113, 0x114, 0x115,
  0x116, 0x117, 0x118, 0x119, 0x11a, 0x11b, 0x11c, 0x11d, 0x11e, 0x11f, 0x120,
  0x121, 0x122, 0x123, 0x124, 0x125, 0x126, 0x127, 0x128, 0x129, 0x12a, 0x12b,
  0x12c, 0x12d, 0x12e, 0x12f, 0x130, 0x139, 0x13a, 0x13b, 0x13c, 0x13d, 0x13f,
  0x140, 0x141, 0x144, 0x145, 0x146, 0x14d, 0x14e, 0x14f, 0x150, 0x151, 0x152,
  0x153, 0x154, 0x155, 0x156, 0x157, 0x158, 0x159,
])
// Also include transparent/sky tiles that appear frequently
const VALID_RANGE_MAX = 0x1FF  // all fg1..an1 chars

// ── LoROM mapping ─────────────────────────────────────────────────────────────
function loromOffset(snesAddr, headerSize = 0) {
  const bank = (snesAddr >> 16) & 0x7F
  const addr = snesAddr & 0xFFFF
  return bank * 0x8000 + (addr - 0x8000) + headerSize
}

// Detect copier header
function headerSize(romBuf) {
  return romBuf.length % 1024 === 512 ? 512 : 0
}

// Read bytes at a SNES address
function readAt(romBuf, hdr, snesAddr, count) {
  const off = loromOffset(snesAddr, hdr)
  if (off < 0 || off + count > romBuf.length) return null
  return romBuf.slice(off, off + count)
}

function readByte(romBuf, hdr, snesAddr) {
  const b = readAt(romBuf, hdr, snesAddr, 1)
  return b ? b[0] : null
}

function readLE16(buf, off) {
  return (buf[off + 1] << 8) | buf[off]
}

// ── Score a decoded word stream ───────────────────────────────────────────────
function scoreWords(words) {
  if (words.length === 0) return { score: 0, total: 0, valid: 0 }
  let valid = 0
  for (const w of words) {
    const charNum = w & 0x3FF
    if (charNum === 0 || VALID_CHAR_SET.has(charNum) || charNum <= VALID_RANGE_MAX) valid++
  }
  return { score: Math.round(valid / words.length * 100), total: words.length, valid }
}

// ── LC_LZ2 decompressor (port of src/rom/LcLz2.ts) ───────────────────────────
function lclz2Decompress(data) {
  const out = []
  let i = 0
  while (i < data.length) {
    const cmd = data[i++]
    if (cmd === 0xFF) break  // end marker
    const type = (cmd >> 5) & 0x7
    let len = (cmd & 0x1F) + 1
    if (type === 7) {
      // Extended length: next byte gives high bits
      if (i >= data.length) break
      const ext = data[i++]
      const newType = (ext >> 5) & 0x7
      len = ((cmd & 0x3) << 8 | ext) + 1
      // Use newType... simplified: just direct copy
      if (i + len > data.length) break
      for (let j = 0; j < len; j++) out.push(data[i++])
      continue
    }
    switch (type) {
      case 0: // Direct copy
        if (i + len > data.length) { i += len; break }
        for (let j = 0; j < len; j++) out.push(data[i++])
        break
      case 1: // Byte fill
        if (i >= data.length) break
        { const fill = data[i++]; for (let j = 0; j < len; j++) out.push(fill) }
        break
      case 2: // Word fill
        if (i + 1 >= data.length) { i += 2; break }
        { const lo = data[i++], hi = data[i++]; for (let j = 0; j < len; j++) { out.push(lo); out.push(hi) } }
        break
      case 3: // Increasing fill
        if (i >= data.length) break
        { let b = data[i++]; for (let j = 0; j < len; j++) out.push(b++) }
        break
      case 4: case 5: case 6: { // Back-reference
        if (i + 1 >= data.length) { i += 2; break }
        let src = readLE16(data, i); i += 2
        if (type === 5) src = out.length - src  // relative
        for (let j = 0; j < len; j++) out.push(out[src + j] ?? 0)
        break
      }
    }
  }
  return Buffer.from(out)
}

// ── Strategy C: Word-RLE ($FFFF terminates) ───────────────────────────────────
// Format hypothesis: [tileWord16][runLen16] pairs until word=$FFFF
// runLen=0 means 1 repetition.
function decodeWordRle(data) {
  const words = []
  let i = 0
  while (i + 1 < data.length) {
    const tileWord = readLE16(data, i); i += 2
    if (tileWord === 0xFFFF) break
    if (i + 1 >= data.length) { words.push(tileWord); break }
    const runLen = readLE16(data, i); i += 2
    const count = Math.max(1, runLen)
    for (let j = 0; j < count && words.length < 4096; j++) words.push(tileWord)
  }
  return words
}

// ── Strategy D: Byte-RLE (count+word, $FF terminates count) ──────────────────
// Format hypothesis: [count8][lo8][hi8] triples. count=0 or $FF terminates.
function decodeByteRle(data) {
  const words = []
  let i = 0
  while (i < data.length) {
    const count = data[i++]
    if (count === 0 || count === 0xFF) break
    if (i + 1 >= data.length) break
    const lo = data[i++], hi = data[i++]
    const w = (hi << 8) | lo
    for (let j = 0; j < count && words.length < 4096; j++) words.push(w)
  }
  return words
}

// ── Strategy E: SMW-style offset-RLE ─────────────────────────────────────────
// Some SMW tables use: if byte < $80 → literal run of (byte+1) words follow
//                      if byte ≥ $80 → fill run: next word repeated (byte-$80+1) times
// Terminated by byte $FF.
function decodeSmwRle(data) {
  const words = []
  let i = 0
  while (i < data.length) {
    const cmd = data[i++]
    if (cmd === 0xFF) break
    if (cmd < 0x80) {
      // Literal: (cmd+1) words follow
      const count = cmd + 1
      for (let j = 0; j < count; j++) {
        if (i + 1 >= data.length) break
        words.push(readLE16(data, i)); i += 2
      }
    } else {
      // Fill: next word repeated (cmd - 0x80 + 1) times
      const count = cmd - 0x80 + 1
      if (i + 1 >= data.length) break
      const w = readLE16(data, i); i += 2
      for (let j = 0; j < count && words.length < 4096; j++) words.push(w)
    }
  }
  return words
}

// ── Strategy F: SMW CODE_058126 byte-RLE (from smw-src/lv_read.s) ────────────
// Exact format from the SMW disassembly (galaxyhaxz/smw-src):
//   Count byte:
//     bit 7 = 1 → RUN mode:  count = (byte & $7F), next byte repeated (count+1) times
//     bit 7 = 0 → LITERAL mode: count = byte, next (count+1) bytes copied verbatim
//   Terminated by TWO consecutive $FF bytes ($FF $FF).
//
// Output: raw bytes in memory order. The output MAY be:
//   (a) Raw SNES BG2 tilemap bytes (lo/hi interleaved) → directly matches VRAM
//   (b) Lo bytes only → hi bytes from a second stream starting after first $FFFF
//   (c) Map16 tile ID bytes → needs Map16 expansion pass
//
// We test (a) by comparing against known VRAM from the Mesen dump.
function decodeSmwCode058126(data) {
  const out = []
  let i = 0
  while (i < data.length) {
    // Check for $FF $FF terminator
    if (data[i] === 0xFF && i + 1 < data.length && data[i + 1] === 0xFF) break
    const cmd = data[i++]
    if (cmd === undefined) break
    if (cmd & 0x80) {
      // RUN mode: bit 7 set → repeat next byte (count+1) times
      const count = (cmd & 0x7F) + 1
      if (i >= data.length) break
      const val = data[i++]
      for (let j = 0; j < count; j++) out.push(val)
    } else {
      // LITERAL mode: bit 7 clear → copy next (count+1) bytes
      const count = cmd + 1
      for (let j = 0; j < count && i < data.length; j++) out.push(data[i++])
    }
  }
  return Buffer.from(out)
}

// ── Main ──────────────────────────────────────────────────────────────────────
function main() {
  const arg = process.argv[2]
  const levelIndex = arg ? (arg.startsWith('0x') ? parseInt(arg, 16) : parseInt(arg, 10)) : 260

  console.log(`\n=== L2 Preset Format Probe — level $${levelIndex.toString(16).toUpperCase().padStart(3,'0')} (decimal ${levelIndex}) ===\n`)

  const romBuf = fs.readFileSync(ROM_PATH)
  const hdr = headerSize(romBuf)
  console.log(`ROM: ${romBuf.length} bytes, header: ${hdr} bytes`)

  // Read L2 pointer (3-byte interleaved)
  const l2Base = 0x05E600 + levelIndex * 3
  const lo  = readByte(romBuf, hdr, l2Base)     ?? 0
  const hi  = readByte(romBuf, hdr, l2Base + 1) ?? 0
  const bk  = readByte(romBuf, hdr, l2Base + 2) ?? 0
  console.log(`L2 pointer bytes: lo=$${lo.toString(16).padStart(2,'0')} hi=$${hi.toString(16).padStart(2,'0')} bk=$${bk.toString(16).padStart(2,'0')}`)

  if (bk !== 0xFF) {
    console.log('Not a preset level (bank ≠ $FF). Use a level with a preset background.')
    process.exit(1)
  }

  const presetSnesAddr = 0x0D0000 | (hi << 8) | lo
  console.log(`Preset SNES addr: $${presetSnesAddr.toString(16).toUpperCase().padStart(6,'0')}\n`)

  // Read up to 8 KB of raw preset data
  const raw = readAt(romBuf, hdr, presetSnesAddr, 0x2000)
  if (!raw) { console.error('Could not read preset data from ROM'); process.exit(1) }

  // Find $FFFF terminator
  let termPos = -1
  for (let i = 0; i + 1 < raw.length; i++) {
    if (raw[i] === 0xFF && raw[i+1] === 0xFF) { termPos = i; break }
  }
  const dataLen = termPos >= 0 ? termPos : raw.length
  const data = raw.slice(0, dataLen)
  console.log(`Raw data: ${dataLen} bytes (${Math.ceil(dataLen/2)} words) before $FFFF terminator at offset ${termPos}`)
  console.log(`First 32 bytes: ${Array.from(data.slice(0, 32)).map(b => b.toString(16).padStart(2,'0')).join(' ')}`)
  console.log(`First 16 words (LE): ${Array.from({length: Math.min(16, Math.floor(data.length/2))}, (_,i) => '$'+readLE16(data,i*2).toString(16).padStart(4,'0')).join(' ')}\n`)

  // ── Strategy A: raw words ─────────────────────────────────────────────────
  {
    const words = Array.from({length: Math.floor(data.length/2)}, (_,i) => readLE16(data, i*2))
    const {score, total, valid} = scoreWords(words)
    console.log(`[A] Raw words       : ${total} words, ${valid} valid charNums (${score}%)`)
    console.log(`    First 8 charNums: ${words.slice(0,8).map(w=>'$'+((w&0x3FF).toString(16).padStart(3,'0'))).join(' ')}`)
  }

  // ── Strategy B: LC_LZ2 ───────────────────────────────────────────────────
  {
    try {
      const decomp = lclz2Decompress(data)
      if (decomp.length === 0) {
        console.log(`[B] LC_LZ2         : decompressed to 0 bytes — not LZ2 format`)
      } else {
        const words = Array.from({length: Math.floor(decomp.length/2)}, (_,i) => readLE16(decomp, i*2))
        const {score, total, valid} = scoreWords(words)
        console.log(`[B] LC_LZ2         : ${decomp.length} bytes → ${total} words, ${valid} valid charNums (${score}%)`)
        console.log(`    First 8 charNums: ${words.slice(0,8).map(w=>'$'+((w&0x3FF).toString(16).padStart(3,'0'))).join(' ')}`)
      }
    } catch (e) {
      console.log(`[B] LC_LZ2         : threw — ${e.message}`)
    }
  }

  // ── Strategy C: Word-RLE ($FFFF terminates each entry) ───────────────────
  {
    const words = decodeWordRle(data)
    const {score, total, valid} = scoreWords(words)
    console.log(`[C] Word-RLE        : ${total} words, ${valid} valid charNums (${score}%)`)
    console.log(`    First 8 charNums: ${words.slice(0,8).map(w=>'$'+((w&0x3FF).toString(16).padStart(3,'0'))).join(' ')}`)
  }

  // ── Strategy D: Byte-RLE ─────────────────────────────────────────────────
  {
    const words = decodeByteRle(data)
    const {score, total, valid} = scoreWords(words)
    console.log(`[D] Byte-RLE        : ${total} words, ${valid} valid charNums (${score}%)`)
    console.log(`    First 8 charNums: ${words.slice(0,8).map(w=>'$'+((w&0x3FF).toString(16).padStart(3,'0'))).join(' ')}`)
  }

  // ── Strategy E: SMW-style offset-RLE ─────────────────────────────────────
  {
    const words = decodeSmwRle(data)
    const {score, total, valid} = scoreWords(words)
    console.log(`[E] SMW-offset-RLE  : ${total} words, ${valid} valid charNums (${score}%)`)
    console.log(`    First 8 charNums: ${words.slice(0,8).map(w=>'$'+((w&0x3FF).toString(16).padStart(3,'0'))).join(' ')}`)
  }

  // ── Strategy F: SMW CODE_058126 byte-RLE (from galaxyhaxz/smw-src) ──────────
  {
    const decomp = decodeSmwCode058126(data)
    console.log(`\n[F] SMW CODE_058126 byte-RLE (from disassembly):`)
    console.log(`    ${data.length} compressed bytes → ${decomp.length} decompressed bytes`)
    console.log(`    First 32 bytes: ${Array.from(decomp.slice(0,32)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`)

    // Hypothesis (a): output is raw SNES BG tilemap (lo/hi interleaved)
    const wordsA = []
    for (let i = 0; i+1 < decomp.length; i += 2) wordsA.push(readLE16(decomp, i))
    const rA = scoreWords(wordsA)
    console.log(`    (a) As interleaved lo/hi words: ${wordsA.length} words, ${rA.valid} valid charNums (${rA.score}%)`)
    console.log(`        First 8 charNums: ${wordsA.slice(0,8).map(w=>'$'+((w&0x3FF).toString(16).padStart(3,'0'))).join(' ')}`)

    // Compare first bytes to known VRAM content (from vram-analysis.md Mesen dump)
    //   VRAM $6000: F8 00 F8 00 ...  (word $00F8 = charNum $0F8, palette 0)
    //   VRAM $7000: 2E 01 2F 01 ...  (words $012E, $012F, ...)
    const known6 = [0xF8,0x00,0xF8,0x00,0xF8,0x00,0xF8,0x00]
    const known7 = [0x2E,0x01,0x2F,0x01,0x2E,0x01,0x2F,0x01]
    let m6=0, m7=0
    for (let i=0; i<8; i++) { if(decomp[i]===known6[i]) m6++; if(decomp[i]===known7[i]) m7++ }
    console.log(`        Byte match vs VRAM $6000 first 8: ${m6}/8`)
    console.log(`        Byte match vs VRAM $7000 first 8: ${m7}/8`)

    // Hypothesis (b): output is the lo-byte stream only; a second stream follows $FFFF
    let termOff = -1
    for (let i=0; i+1 < raw.length; i++) { if(raw[i]===0xFF && raw[i+1]===0xFF){termOff=i;break} }
    if (termOff >= 0 && termOff+2 < raw.length) {
      const rest = raw.slice(termOff+2)
      let term2 = -1
      for (let i=0; i+1 < rest.length; i++) { if(rest[i]===0xFF && rest[i+1]===0xFF){term2=i;break} }
      console.log(`\n    (b) Second stream at ROM offset +${termOff+2}:`)
      if (term2 > 0) {
        const decomp2 = decodeSmwCode058126(rest.slice(0, term2+2))
        console.log(`        ${term2} compressed bytes → ${decomp2.length} decompressed bytes`)
        console.log(`        First 16 bytes: ${Array.from(decomp2.slice(0,16)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`)
        // Interleave lo (decomp) + hi (decomp2) into 16-bit words
        const words2 = []
        for (let i=0; i<Math.min(decomp.length,decomp2.length); i++) words2.push((decomp2[i]<<8)|decomp[i])
        const r2 = scoreWords(words2)
        console.log(`        Interleaved → ${words2.length} words, ${r2.valid} valid charNums (${r2.score}%)`)
        console.log(`        First 8 charNums: ${words2.slice(0,8).map(w=>'$'+((w&0x3FF).toString(16).padStart(3,'0'))).join(' ')}`)
        let m6b=0, m7b=0
        for (let i=0; i<4; i++) { if(words2[i]===0x00F8)m6b++; if(words2[i]===0x012E||words2[i]===0x012F)m7b++ }
        console.log(`        Word match vs VRAM $6000 ($00F8): ${m6b}/4`)
        console.log(`        Word match vs VRAM $7000 ($012E/$012F): ${m7b}/4`)
      } else {
        console.log(`        No second $FFFF terminator found in next ${rest.length} bytes`)
        console.log(`        First 16 bytes: ${Array.from(rest.slice(0,16)).map(b=>b.toString(16).padStart(2,'0')).join(' ')}`)
      }
    }
  }

  // ── Map16 expansion check ─────────────────────────────────────────────────
  // If the decompressed bytes are single-byte Map16 tile IDs, looking up the
  // TL charNum of tile $29 via the ROM Map16 table should give ~$12E (the first
  // charNum observed in the Mesen VRAM BG2 dump at $7000).
  {
    const MAP16_PAGE0 = 0x0D8000  // tiles $000–$0FF, 8 bytes each
    const MAP16_PAGE1 = 0x0DC000  // tiles $100–$1FF, 8 bytes each
    const TILE_BYTES  = 8

    function readMap16Tile(romBuf, hdr, tileId) {
      const base = tileId < 0x100 ? MAP16_PAGE0 : MAP16_PAGE1
      const idx  = tileId < 0x100 ? tileId : tileId - 0x100
      const addr = base + idx * TILE_BYTES
      const buf  = readAt(romBuf, hdr, addr, TILE_BYTES)
      if (!buf) return null
      // Order: TL, BL, TR, BR (column-major)
      const tl = readLE16(buf, 0), bl = readLE16(buf, 2), tr = readLE16(buf, 4), br = readLE16(buf, 6)
      return { tl, bl, tr, br }
    }

    console.log('\n── Map16 tile lookup (hypothesis: decompressed bytes = Map16 IDs) ──')
    // Check first few unique byte values from decompressor output
    const decomp = decodeSmwCode058126(data)
    const sampleIds = [...new Set(Array.from(decomp.slice(0, 256)))].slice(0, 8)
    for (const id of sampleIds) {
      const t = readMap16Tile(romBuf, hdr, id)
      if (t) {
        const tlChar = t.tl & 0x3FF, tlPal = (t.tl >> 10) & 7
        console.log(`  Map16[$${id.toString(16).padStart(2,'0')}] TL=$${t.tl.toString(16).padStart(4,'0')} charNum=$${tlChar.toString(16).padStart(3,'0')} palette=${tlPal}  ` +
          `BL=$${t.bl.toString(16).padStart(4,'0')} TR=$${t.tr.toString(16).padStart(4,'0')} BR=$${t.br.toString(16).padStart(4,'0')}`)
      }
    }
    // Also explicitly look up tile $29 (most common in first output) and $39
    for (const id of [0x29, 0x39, 0x09]) {
      const t = readMap16Tile(romBuf, hdr, id)
      if (t) {
        const tlChar = t.tl & 0x3FF
        console.log(`  Map16[$${id.toString(16).padStart(2,'0')}] TL charNum=$${tlChar.toString(16).padStart(3,'0')} (VRAM $7000 wants $12E, $12F ...)`)
      }
    }
  }

  console.log('\nExpected charNums for level $104 BG2: $000, $0f8, $12e, $12f, $100–$159...')
  console.log('A strategy scoring ≥80% is likely the correct format.\n')
}

main()
