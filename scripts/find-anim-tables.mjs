/**
 * find-anim-tables.mjs
 *
 * Searches the SMW ROM (bank $00) for animated tile frame data:
 *   1. Pointer tables in bank $00 pointing into GFX banks $08-$0B
 *   2. Jump tables (2-byte addresses $8000-$FFFF within bank $00)
 *   3. Repeating 24/32-byte tile-size patterns in $00A000-$00B000
 *   4. Uncompressed 3bpp tile data appearing as animation frames
 *
 * LoROM address to file offset:
 *   hasHeader = romSize % 1024 === 512
 *   hdrOff    = hasHeader ? 512 : 0
 *   bank      = (snesAddr >> 16) & 0x7F
 *   offset    = hdrOff + bank * 0x8000 + (snesAddr & 0x7FFF)  [snesAddr & 0xFFFF >= 0x8000]
 */

import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import path from 'path';

const ROM_PATH = 'C:/Projects/frontend/test/roms/Super Mario World (USA).sfc';
const rom = readFileSync(ROM_PATH);

const hasHeader = rom.length % 1024 === 512;
const hdrOff = hasHeader ? 512 : 0;
console.log(`ROM size: ${rom.length} bytes, header: ${hasHeader}, hdrOff: ${hdrOff}`);

// ──────────────────────────────────────────────────────────────────────────────
// Address helpers
// ──────────────────────────────────────────────────────────────────────────────

function snesLoRomToOffset(snesAddr) {
  const bank = (snesAddr >> 16) & 0x7F;
  const lo   = snesAddr & 0xFFFF;
  if (lo < 0x8000) return null;          // lo-ROM data region not valid this way
  return hdrOff + bank * 0x8000 + (lo - 0x8000);
}

function offsetToSnes(offset) {
  const romOff = offset - hdrOff;
  const bank   = Math.floor(romOff / 0x8000);
  const lo     = 0x8000 + (romOff % 0x8000);
  return (bank << 16) | lo;
}

function read3(offset) {
  return rom[offset] | (rom[offset+1] << 8) | (rom[offset+2] << 16);
}
function read2(offset) {
  return rom[offset] | (rom[offset+1] << 8);
}

function hexAddr(n) { return '$' + n.toString(16).toUpperCase().padStart(6,'0'); }
function hexOff(n)  { return '0x' + n.toString(16).toUpperCase().padStart(6,'0'); }
function hexByte(n) { return n.toString(16).toUpperCase().padStart(2,'0'); }
function hexBytes(buf, start, len) {
  return Array.from(buf.subarray(start, start+len)).map(hexByte).join(' ');
}

// ──────────────────────────────────────────────────────────────────────────────
// Tile-graphics heuristic: high proportion of 0x00/0xFF bytes
// ──────────────────────────────────────────────────────────────────────────────

function looksLikeTileGfx(offset, len = 64) {
  if (offset + len > rom.length) return false;
  let zeros = 0, maxs = 0;
  for (let i = 0; i < len; i++) {
    const b = rom[offset + i];
    if (b === 0x00) zeros++;
    if (b === 0xFF) maxs++;
  }
  return (zeros + maxs) / len >= 0.4;
}

// ──────────────────────────────────────────────────────────────────────────────
// Is this a valid LoROM pointer into GFX banks $08-$0B?
// ──────────────────────────────────────────────────────────────────────────────

function isGfxPointer(addr) {
  const bank = (addr >> 16) & 0xFF;
  const lo   = addr & 0xFFFF;
  return bank >= 0x08 && bank <= 0x0B && lo >= 0x8000;
}

function isBank00Pointer(addr) {
  const bank = (addr >> 16) & 0xFF;
  const lo   = addr & 0xFFFF;
  return bank === 0x00 && lo >= 0x8000 && lo <= 0xFFFF;
}

// ──────────────────────────────────────────────────────────────────────────────
// 1. Scan all of bank $00 ROM area for 3-byte GFX pointer tables
//    Bank $00 ROM area in file: hdrOff + 0*0x8000 .. hdrOff + 0x7FFF
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 1 — Scanning bank $00 for 3-byte GFX pointer tables ($08-$0B)');
console.log('══════════════════════════════════════════════════════════════');

const bank00Start = hdrOff;
const bank00End   = hdrOff + 0x8000;

const gfxPtrTableCandidates = [];

// Slide a 3-byte window looking for runs of GFX pointers
let i = bank00Start;
while (i <= bank00End - 3) {
  const addr = read3(i);
  if (isGfxPointer(addr)) {
    // Count how many consecutive valid GFX pointers start here
    let count = 0;
    let j = i;
    while (j + 3 <= bank00End) {
      const a = read3(j);
      if (!isGfxPointer(a)) break;
      count++;
      j += 3;
    }
    if (count >= 2) {
      const snesTableAddr = offsetToSnes(i);
      gfxPtrTableCandidates.push({ fileOffset: i, snesAddr: snesTableAddr, count });
      console.log(`\nGFX pointer table at ${hexAddr(snesTableAddr)} (file ${hexOff(i)}): ${count} entries`);
      for (let k = 0; k < Math.min(count, 16); k++) {
        const ptr = read3(i + k*3);
        const ptrOff = snesLoRomToOffset(ptr);
        const gfxPreview = ptrOff !== null ? hexBytes(rom, ptrOff, 32) : '(unmapped)';
        const looksGfx   = ptrOff !== null ? looksLikeTileGfx(ptrOff) : false;
        console.log(`  [${k.toString().padStart(2)}] -> ${hexAddr(ptr)} (file ${ptrOff !== null ? hexOff(ptrOff) : 'N/A'}) ${looksGfx ? '[GFX?]' : ''}`);
        console.log(`         ${gfxPreview}`);
      }
      if (count > 16) console.log(`  ... and ${count - 16} more entries`);
    }
    i = j; // skip past this run
  } else {
    i++;
  }
}

if (gfxPtrTableCandidates.length === 0) {
  console.log('  (none found)');
}

// ──────────────────────────────────────────────────────────────────────────────
// 2. Scan bank $00 for 2-byte jump tables (addresses $8000-$FFFF in bank $00)
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 2 — Scanning bank $00 for 2-byte jump tables ($8000-$FFFF)');
console.log('══════════════════════════════════════════════════════════════');

const jumpTableCandidates = [];
i = bank00Start;
while (i <= bank00End - 2) {
  const addr = read2(i);
  if (addr >= 0x8000 && addr <= 0xFFFF) {
    let count = 0;
    let j = i;
    while (j + 2 <= bank00End) {
      const a = read2(j);
      if (a < 0x8000 || a > 0xFFFF) break;
      count++;
      j += 2;
    }
    if (count >= 4) {
      const snesTableAddr = offsetToSnes(i);
      jumpTableCandidates.push({ fileOffset: i, snesAddr: snesTableAddr, count });
      // Only print interesting ones (8+ entries or in suspected range)
      const snes = snesTableAddr & 0xFFFF;
      if (count >= 8 || (snes >= 0xA000 && snes <= 0xB000)) {
        console.log(`\nJump table at ${hexAddr(snesTableAddr)} (file ${hexOff(i)}): ${count} entries`);
        for (let k = 0; k < Math.min(count, 12); k++) {
          const ptr = read2(i + k*2);
          console.log(`  [${k.toString().padStart(2)}] -> $${ptr.toString(16).toUpperCase().padStart(4,'0')} (bank $00: ${hexAddr(0x000000 | ptr)})`);
        }
        if (count > 12) console.log(`  ... and ${count - 12} more`);
      }
    }
    i = j;
  } else {
    i++;
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 3. Deep scan $00A000-$00B000 for ALL pointer/pattern types
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 3 — Deep scan $00A000-$00B000');
console.log('══════════════════════════════════════════════════════════════');

const scanStart = snesLoRomToOffset(0x00A000) ?? (hdrOff + (0xA000 - 0x8000));
const scanEnd   = snesLoRomToOffset(0x00B000) ?? (hdrOff + (0xB000 - 0x8000));

console.log(`File range: ${hexOff(scanStart)} - ${hexOff(scanEnd)}`);

// 3a. Hex dump of region in 16-byte rows
console.log('\n--- Raw hex dump $00A000-$00A100 ---');
for (let r = scanStart; r < Math.min(scanStart + 0x100, scanEnd); r += 16) {
  const bytes = hexBytes(rom, r, Math.min(16, scanEnd - r));
  const snes  = hexAddr(offsetToSnes(r));
  console.log(`${snes}: ${bytes}`);
}

// 3b. Look for 24-byte repeating patterns (3bpp tiles)
console.log('\n--- Searching for 24-byte repeated patterns in $00A000-$00B000 ---');
const seen24 = new Map();
for (let r = scanStart; r + 24 <= scanEnd; r++) {
  const key = Buffer.from(rom.subarray(r, r+24)).toString('hex');
  if (!seen24.has(key)) seen24.set(key, []);
  seen24.get(key).push(r);
}
let found24 = 0;
for (const [key, offsets] of seen24) {
  if (offsets.length >= 2 && key !== '0'.repeat(48) && key !== 'ff'.repeat(24)) {
    found24++;
    if (found24 <= 20) {
      const snesAddrs = offsets.map(o => hexAddr(offsetToSnes(o))).join(', ');
      console.log(`  24-byte pattern appears ${offsets.length}x: ${snesAddrs}`);
      console.log(`    ${key.match(/.{2}/g).join(' ')}`);
    }
  }
}
console.log(`Total unique 24-byte patterns appearing 2+ times: ${found24}`);

// 3c. Look for 32-byte repeating patterns (4bpp tiles)
console.log('\n--- Searching for 32-byte repeated patterns in $00A000-$00B000 ---');
const seen32 = new Map();
for (let r = scanStart; r + 32 <= scanEnd; r++) {
  const key = Buffer.from(rom.subarray(r, r+32)).toString('hex');
  if (!seen32.has(key)) seen32.set(key, []);
  seen32.get(key).push(r);
}
let found32 = 0;
for (const [key, offsets] of seen32) {
  if (offsets.length >= 2 && key !== '0'.repeat(64) && key !== 'ff'.repeat(32)) {
    found32++;
    if (found32 <= 20) {
      const snesAddrs = offsets.map(o => hexAddr(offsetToSnes(o))).join(', ');
      console.log(`  32-byte pattern appears ${offsets.length}x: ${snesAddrs}`);
      console.log(`    ${key.match(/.{2}/g).join(' ')}`);
    }
  }
}
console.log(`Total unique 32-byte patterns appearing 2+ times: ${found32}`);

// ──────────────────────────────────────────────────────────────────────────────
// 4. Known SMW animation table addresses from disassembly lore:
//    Check $00A0C0, $00A0D4, $00A0E4, $00B5B4, $00C0A7, $00B992 area
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 4 — Probing known/suspected SMW animation addresses');
console.log('══════════════════════════════════════════════════════════════');

const probeAddrs = [
  // Animation-related addresses commonly cited in SMW hacking docs
  0x00A0A0, 0x00A0C0, 0x00A0D0, 0x00A0E0, 0x00A100,
  0x00A200, 0x00A300, 0x00A400, 0x00A500, 0x00A600,
  0x00A700, 0x00A800, 0x00A900, 0x00AA00, 0x00AB00,
  0x00B000, 0x00B100, 0x00B200, 0x00B300, 0x00B400,
  0x00B500, 0x00B5B4,
  // GFX pointer tables already known
  0x00B992, 0x00B9C4, 0x00B9F6,
  // Check right before/after known tables
  0x00B900, 0x00B940, 0x00B960, 0x00B980,
  // Check common SMW AnimFG area
  0x00C000, 0x00C0A0, 0x00C100,
];

for (const snes of probeAddrs) {
  const off = snesLoRomToOffset(snes);
  if (off === null || off + 32 > rom.length) continue;
  const bytes = hexBytes(rom, off, 32);
  // Check if first few bytes look like 3-byte LoROM pointers into $08-$0B
  const p0 = read3(off);
  const p1 = read3(off+3);
  const p2 = read3(off+6);
  const isGfxTbl = isGfxPointer(p0) && isGfxPointer(p1) && isGfxPointer(p2);
  const isJmpTbl = (p0 & 0xFFFF) >= 0x8000 && (p1 & 0xFFFF) >= 0x8000;
  const label = isGfxTbl ? ' *** GFX PTR TABLE ***' : (isJmpTbl ? ' [possible jump table]' : '');
  console.log(`${hexAddr(snes)} (${hexOff(off)}):${label}`);
  console.log(`  ${bytes}`);
  if (isGfxTbl) {
    // Count full run
    let cnt = 0;
    let cur = off;
    while (cur + 3 <= rom.length && isGfxPointer(read3(cur))) { cnt++; cur += 3; }
    console.log(`  -> ${cnt} consecutive GFX pointers`);
    for (let k = 0; k < Math.min(cnt, 8); k++) {
      const ptr = read3(off + k*3);
      const poff = snesLoRomToOffset(ptr);
      const preview = poff ? hexBytes(rom, poff, 32) : '(N/A)';
      console.log(`  [${k}] ${hexAddr(ptr)}: ${preview}`);
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 5. Search entire bank $00 for runs of GFX pointers of length >= 4
//    AND also search banks $01-$03 (common for code/data in LoROM)
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 5 — All GFX pointer runs >= 4 entries across banks $00-$03');
console.log('══════════════════════════════════════════════════════════════');

for (let bankNum = 0; bankNum <= 3; bankNum++) {
  const bStart = hdrOff + bankNum * 0x8000;
  const bEnd   = bStart + 0x8000;
  let bi = bStart;
  while (bi <= bEnd - 3) {
    const addr = read3(bi);
    if (isGfxPointer(addr)) {
      let count = 0;
      let bj = bi;
      while (bj + 3 <= bEnd && isGfxPointer(read3(bj))) { count++; bj += 3; }
      if (count >= 4) {
        const snesTableAddr = offsetToSnes(bi);
        console.log(`\n  Bank $${bankNum.toString(16).padStart(2,'0')} GFX ptr table at ${hexAddr(snesTableAddr)} (${hexOff(bi)}): ${count} entries`);
        for (let k = 0; k < Math.min(count, 8); k++) {
          const ptr = read3(bi + k*3);
          const poff = snesLoRomToOffset(ptr);
          const preview = poff ? hexBytes(rom, poff, 32) : '(N/A)';
          const gfx = poff ? (looksLikeTileGfx(poff) ? '[GFX]' : '') : '';
          console.log(`    [${k.toString().padStart(2)}] ${hexAddr(ptr)} ${gfx}: ${preview}`);
        }
        if (count > 8) console.log(`    ... and ${count-8} more`);
      }
      bi = bj;
    } else {
      bi++;
    }
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 6. Search for the SMW animation frame sequence table
//    SMW uses a table of (frameCount, framePtr...) structures
//    Also look for tables where every 3-byte entry points to similar-sized data
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 6 — Search for animation frame pointer tables in bank $00');
console.log('         (sequences where pointed data all has same size = anim frames)');
console.log('══════════════════════════════════════════════════════════════');

// Known SMW: animated tiles live in GFX banks, frames are 24-byte (3bpp) or 32-byte (2bpp/4bpp) tiles
// An anim sequence table would have N pointers pointing to data at regular spacing

// Strategy: for each 3-byte GFX pointer run of 2+, check if pointed data is equidistant
function checkAnimSequence(tableOff, count) {
  if (count < 2) return null;
  const ptrs = [];
  for (let k = 0; k < count; k++) {
    const addr = read3(tableOff + k*3);
    const off  = snesLoRomToOffset(addr);
    if (off === null) return null;
    ptrs.push({ addr, off });
  }
  // Check spacing between consecutive pointers
  const spacings = [];
  for (let k = 1; k < ptrs.length; k++) {
    // spacing in SNES address space
    const diff = ptrs[k].addr - ptrs[k-1].addr;
    spacings.push(diff);
  }
  const firstSpacing = spacings[0];
  const uniform = spacings.every(s => s === firstSpacing);
  return { ptrs, spacings, uniform, spacing: firstSpacing };
}

// Re-scan bank $00 collecting all GFX ptr runs of 2+ and analyze them
i = bank00Start;
const animCandidates = [];
while (i <= bank00End - 3) {
  const addr = read3(i);
  if (isGfxPointer(addr)) {
    let count = 0;
    let j = i;
    while (j + 3 <= bank00End && isGfxPointer(read3(j))) { count++; j += 3; }
    if (count >= 2) {
      const analysis = checkAnimSequence(i, count);
      if (analysis && analysis.uniform && analysis.spacing > 0) {
        const snesAddr = offsetToSnes(i);
        animCandidates.push({ fileOffset: i, snesAddr, count, analysis });
      }
    }
    i = j;
  } else {
    i++;
  }
}

if (animCandidates.length === 0) {
  console.log('  No uniform-spaced GFX pointer sequences found in bank $00');
} else {
  for (const c of animCandidates) {
    const { fileOffset, snesAddr, count, analysis } = c;
    console.log(`\n  Uniform anim sequence at ${hexAddr(snesAddr)} (${hexOff(fileOffset)}): ${count} frames, spacing=${analysis.spacing} bytes`);
    for (let k = 0; k < Math.min(count, 8); k++) {
      const { addr, off } = analysis.ptrs[k];
      const preview = hexBytes(rom, off, 24);
      console.log(`    [${k}] ${hexAddr(addr)}: ${preview}`);
    }
    if (count > 8) console.log(`    ... and ${count-8} more frames`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// 7. Check for LC_LZ2 compression signatures at GFX pointer destinations
//    LC_LZ2 header byte: command = (byte >> 5) & 7, length encoded in lower bits
//    If first byte is 0xFF it's "end", 0x00-0x1F is raw copy (common first cmd)
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 7 — Check compression status of GFX pointer targets');
console.log('══════════════════════════════════════════════════════════════');

function looksCompressed(offset) {
  if (offset + 2 > rom.length) return false;
  const b0 = rom[offset];
  if (b0 === 0xFF) return false; // empty compressed stream
  const cmd = (b0 >> 5) & 7;
  // LC_LZ2: commands 0-6 valid, 7 is extended
  return cmd <= 7;
}

function isLcLz2(offset) {
  // Heuristic: valid LC_LZ2 starts with a byte where top 3 bits form valid command 0-6
  // and the decompressed stream should be reasonable
  if (offset + 4 > rom.length) return false;
  const b0 = rom[offset];
  const cmd = (b0 >> 5) & 7;
  if (cmd === 7) {
    // Extended: next byte has extended cmd
    const ext = (rom[offset+1] >> 2) & 7;
    return ext <= 4;
  }
  return cmd <= 5; // commands 0-5 are standard LC_LZ2 commands
}

// Check all GFX pointer targets found in pass 1 and pass 5
const allGfxPtrs = new Set();
for (const cand of gfxPtrTableCandidates) {
  for (let k = 0; k < cand.count; k++) {
    allGfxPtrs.add(read3(cand.fileOffset + k*3));
  }
}

// Also probe the known GFX pointer tables
for (const snes of [0x00B992, 0x00B9C4, 0x00B9F6]) {
  const off = snesLoRomToOffset(snes);
  if (!off) continue;
  let j = off;
  while (j + 3 <= rom.length && isGfxPointer(read3(j))) {
    allGfxPtrs.add(read3(j));
    j += 3;
  }
}

let compressedCount = 0, rawCount = 0;
const compressionSamples = { compressed: [], raw: [] };
for (const ptr of allGfxPtrs) {
  const off = snesLoRomToOffset(ptr);
  if (!off) continue;
  const compressed = isLcLz2(off);
  if (compressed) {
    compressedCount++;
    if (compressionSamples.compressed.length < 3) compressionSamples.compressed.push({ ptr, off });
  } else {
    rawCount++;
    if (compressionSamples.raw.length < 3) compressionSamples.raw.push({ ptr, off });
  }
}

console.log(`\nOf ${allGfxPtrs.size} unique GFX pointers sampled:`);
console.log(`  Likely LC_LZ2 compressed: ${compressedCount}`);
console.log(`  Likely raw/uncompressed:  ${rawCount}`);

console.log('\nSample compressed targets:');
for (const { ptr, off } of compressionSamples.compressed) {
  console.log(`  ${hexAddr(ptr)} (${hexOff(off)}): ${hexBytes(rom, off, 32)}`);
}
console.log('\nSample raw targets:');
for (const { ptr, off } of compressionSamples.raw) {
  console.log(`  ${hexAddr(ptr)} (${hexOff(off)}): ${hexBytes(rom, off, 32)}`);
}

// ──────────────────────────────────────────────────────────────────────────────
// 8. Targeted search: known SMW anim system from disassembly
//    The AnimFG routine typically reads from a table at fixed address.
//    Common addresses from SMW ASM disassembly: $009B7E, $00A084, $00A0BF, $00A2xx
//    Also check around $00B990 (near GFX table we know)
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 8 — Scanning $009800-$00B992 for GFX ptr clusters');
console.log('══════════════════════════════════════════════════════════════');

const p8Start = snesLoRomToOffset(0x009800) ?? (hdrOff + (0x9800 - 0x8000));
const p8End   = snesLoRomToOffset(0x00B992) ?? (hdrOff + (0xB992 - 0x8000));

console.log(`Scanning file ${hexOff(p8Start)}-${hexOff(p8End)}`);

// Print full hex dump of this region in 16-byte rows with SNES addresses
// but only flag interesting addresses (where 3-byte GFX ptrs appear)
const clusterHits = [];
for (let r = p8Start; r < p8End - 2; r += 3) {
  const a = read3(r);
  if (isGfxPointer(a)) {
    clusterHits.push({ off: r, addr: a, snes: offsetToSnes(r) });
  }
}

if (clusterHits.length > 0) {
  console.log(`\nGFX-pointer-aligned bytes at 3-byte boundaries in $9800-$B992:`);
  // Group by proximity
  let lastOff = -100;
  for (const h of clusterHits) {
    if (h.off - lastOff > 6) console.log('');
    const off = snesLoRomToOffset(h.addr);
    const preview = off ? hexBytes(rom, off, 16) : '(N/A)';
    const gfx = off ? (looksLikeTileGfx(off) ? '[GFX]' : '') : '';
    console.log(`  ${hexAddr(h.snes)}: -> ${hexAddr(h.addr)} ${gfx}  ${preview}`);
    lastOff = h.off;
  }
} else {
  console.log('  No GFX pointers found at 3-byte boundaries in this range');
}

// ──────────────────────────────────────────────────────────────────────────────
// 9. Dump the raw hex around the known GFX pointer table heads to understand
//    what comes BEFORE them (which might be the anim sequencing table)
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 9 — Context around known GFX tables at $00B992/B9C4/B9F6');
console.log('══════════════════════════════════════════════════════════════');

for (const snes of [0x00B992, 0x00B9C4, 0x00B9F6]) {
  const off = snesLoRomToOffset(snes);
  if (!off) continue;
  const ctxStart = Math.max(bank00Start, off - 0x40);
  console.log(`\n--- Context at ${hexAddr(snes)} (${hexOff(off)}), showing -64 to +96 bytes ---`);
  for (let r = ctxStart; r < off + 0x60 && r + 16 <= rom.length; r += 16) {
    const marker = r === off ? '>>>' : '   ';
    console.log(`${marker} ${hexAddr(offsetToSnes(r))}: ${hexBytes(rom, r, 16)}`);
  }

  // Show pointer targets
  let cnt = 0;
  let cur = off;
  while (cur + 3 <= rom.length && isGfxPointer(read3(cur))) { cnt++; cur += 3; }
  console.log(`\n  Table has ${cnt} entries:`);
  for (let k = 0; k < Math.min(cnt, 12); k++) {
    const ptr = read3(off + k*3);
    const poff = snesLoRomToOffset(ptr);
    const preview = poff ? hexBytes(rom, poff, 32) : '(N/A)';
    const isComp = poff ? isLcLz2(poff) : false;
    console.log(`  [${k.toString().padStart(2)}] ${hexAddr(ptr)}: ${isComp ? '[LC_LZ2]' : '[RAW]  '} ${preview}`);
  }
  if (cnt > 12) console.log(`  ... and ${cnt-12} more`);
}

// ──────────────────────────────────────────────────────────────────────────────
// 10. Search ALL of bank $00 for sequences of bytes that match the pattern:
//     byte_count, addr_lo, addr_hi, addr_bank (i.e., 1-byte count + 3-byte ptr)
//     This is a common format for animation tables
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 10 — Search for (count + 3-byte ptr) anim table pattern');
console.log('══════════════════════════════════════════════════════════════');

const animTableCandidates2 = [];
for (let r = bank00Start; r < bank00End - 8; r++) {
  const frameCount = rom[r];
  if (frameCount < 2 || frameCount > 32) continue;
  // Check if frameCount consecutive 3-byte entries follow
  let allGfx = true;
  for (let k = 0; k < frameCount && k < 16; k++) {
    const pOff = r + 1 + k*3;
    if (pOff + 3 > bank00End) { allGfx = false; break; }
    const ptr = read3(pOff);
    if (!isGfxPointer(ptr)) { allGfx = false; break; }
  }
  if (allGfx && frameCount >= 2) {
    const snes = offsetToSnes(r);
    animTableCandidates2.push({ off: r, snes, frameCount });
    console.log(`\n  Candidate at ${hexAddr(snes)}: frameCount=${frameCount}`);
    for (let k = 0; k < Math.min(frameCount, 8); k++) {
      const ptr = read3(r + 1 + k*3);
      const poff = snesLoRomToOffset(ptr);
      const preview = poff ? hexBytes(rom, poff, 24) : '(N/A)';
      console.log(`    [${k}] ${hexAddr(ptr)}: ${preview}`);
    }
  }
}

if (animTableCandidates2.length === 0) {
  console.log('  None found');
}

// ──────────────────────────────────────────────────────────────────────────────
// 11. Find uncompressed 3bpp tile animation frames:
//     Look in GFX banks $08-$0B for regions of 24-byte patterns appearing
//     multiple times with slight variation (animation frames)
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('PASS 11 — Search GFX banks $08-$0B for repeated ~24-byte patterns');
console.log('          (animation frames appear multiple times with slight variation)');
console.log('══════════════════════════════════════════════════════════════');

// We want to find 24-byte chunks where multiple chunks are very similar
// (differ by <= 4 bytes) — these are animation frames of the same tile

function hammingDistance24(a, b, offA, offB) {
  let d = 0;
  for (let k = 0; k < 24; k++) {
    if (a[offA+k] !== b[offB+k]) d++;
  }
  return d;
}

// Sample at 24-byte boundaries in GFX banks
const gfxBankSamples = [];
for (let bankNum = 8; bankNum <= 11; bankNum++) {
  const bStart = hdrOff + bankNum * 0x8000;
  const bEnd   = bStart + 0x8000;
  for (let r = bStart; r + 24 <= bEnd; r += 24) {
    // Skip all-zero or all-0xFF
    let zeros = 0, maxs = 0;
    for (let k = 0; k < 24; k++) {
      if (rom[r+k] === 0) zeros++;
      if (rom[r+k] === 0xFF) maxs++;
    }
    if (zeros >= 22 || maxs >= 22) continue;
    gfxBankSamples.push(r);
  }
}

console.log(`\nNon-trivial 24-byte chunks (at 24-byte boundaries) in $08-$0B: ${gfxBankSamples.length}`);

// Find clusters of similar 24-byte chunks
// For efficiency, compare consecutive same-bank chunks
const similarPairs = [];
for (let i = 0; i < gfxBankSamples.length - 1; i++) {
  const a = gfxBankSamples[i];
  for (let j = i+1; j < Math.min(i+20, gfxBankSamples.length); j++) {
    const b = gfxBankSamples[j];
    if (Math.abs(a - b) > 0x1000) break; // only compare nearby chunks
    const d = hammingDistance24(rom, rom, a, b);
    if (d >= 1 && d <= 8) {
      similarPairs.push({ a, b, distance: d });
    }
  }
}

console.log(`Similar 24-byte pairs (1-8 bytes different): ${similarPairs.length}`);

// Group into clusters
const clustered = new Map();
for (const pair of similarPairs) {
  const key = pair.a;
  if (!clustered.has(key)) clustered.set(key, new Set([pair.a]));
  clustered.get(key).add(pair.b);
}

// Show largest clusters
const clusters = [...clustered.entries()]
  .sort((a,b) => b[1].size - a[1].size)
  .slice(0, 10);

console.log('\nTop animation frame clusters (by cluster size):');
for (const [base, members] of clusters) {
  const addrs = [...members].map(o => hexAddr(offsetToSnes(o)));
  console.log(`\n  Base ${hexAddr(offsetToSnes(base))}: ${members.size} similar chunks`);
  for (const o of [...members].slice(0, 6)) {
    console.log(`    ${hexAddr(offsetToSnes(o))}: ${hexBytes(rom, o, 24)}`);
  }
}

// ──────────────────────────────────────────────────────────────────────────────
// Summary
// ──────────────────────────────────────────────────────────────────────────────

console.log('\n══════════════════════════════════════════════════════════════');
console.log('SUMMARY');
console.log('══════════════════════════════════════════════════════════════');
console.log(`GFX pointer table candidates in bank $00: ${gfxPtrTableCandidates.length}`);
console.log(`Jump table candidates in bank $00: ${jumpTableCandidates.length}`);
console.log(`Uniform-spaced GFX pointer sequences (anim frames?): ${animCandidates.length}`);
console.log(`Count+ptr anim table candidates: ${animTableCandidates2.length}`);
console.log(`Similar 24-byte pairs in GFX banks: ${similarPairs.length}`);
for (const c of animCandidates) {
  const { snesAddr, count, analysis } = c;
  console.log(`  >> ${hexAddr(snesAddr)}: ${count} frames, spacing=${analysis.spacing} (0x${analysis.spacing.toString(16)}) bytes`);
}
