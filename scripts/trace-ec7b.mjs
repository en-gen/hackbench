/**
 * trace-ec7b.mjs
 *
 * Dumps and traces the overworld level name display code at SNES $00EC7B.
 * This is the routine that:
 *   1. Reads name_id from the tile→name_id table ($00E90A)
 *   2. Uses name_id to look up a composition (token sequence)
 *   3. Renders each token's text by calling $00F127
 *
 * We want to find STEP 2: where does name_id index into to get token IDs?
 *
 * Also dumps:
 *   - 512 bytes around $00EC7B to capture the full routine
 *   - The token display subr at $00F127 (first 128 bytes)
 *   - Any tables referenced via LDA abs,X / LDA long,X / LDA abs,Y in that region
 *
 * Usage:
 *   node scripts/trace-ec7b.mjs <rom.sfc>
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

function fileOffset(snesAddr, hasHeader) {
  const bank = (snesAddr >>> 16) & 0x7F
  const addr = snesAddr & 0xFFFF
  if (addr < 0x8000) {
    // Bank $00 low = mirrors. For $00:0000–$00:7FFF treat as file $0000+
    return addr + (hasHeader ? COPIER_HEADER : 0)
  }
  return bank * 0x8000 + (addr - 0x8000) + (hasHeader ? COPIER_HEADER : 0)
}

// ── Decode 65816 instructions ─────────────────────────────────────────────────
// Simplified disassembler — handles common opcodes only.
// Assumes M=1, X=1 (8-bit A and index) for overworld code.

const OP = {
  0x00: ['BRK', 1], 0x08: ['PHP', 0], 0x18: ['CLC', 0], 0x1A: ['INC', 0],
  0x20: ['JSR', 2], 0x22: ['JSL', 3], 0x28: ['PLP', 0], 0x29: ['AND#', 1],
  0x2A: ['ROL', 0], 0x38: ['SEC', 0], 0x3A: ['DEC', 0], 0x3F: ['LDA lng,X', 3],
  0x40: ['RTI', 0], 0x42: ['WDM', 1], 0x48: ['PHA', 0], 0x4A: ['LSR', 0],
  0x4B: ['PHK', 0], 0x4C: ['JMP', 2], 0x5C: ['JML', 3], 0x60: ['RTS', 0],
  0x61: ['ADC(dp,X)', 1], 0x62: ['PER', 2], 0x64: ['STZ dp', 1], 0x65: ['ADC dp', 1],
  0x68: ['PLA', 0], 0x69: ['ADC#', 1], 0x6B: ['RTL', 0], 0x6C: ['JMP()', 2],
  0x70: ['BVS', 1], 0x78: ['SEI', 0], 0x80: ['BRA', 1], 0x82: ['BRL', 2],
  0x84: ['STY dp', 1], 0x85: ['STA dp', 1], 0x86: ['STX dp', 1], 0x88: ['DEY', 0],
  0x89: ['BIT#', 1], 0x8A: ['TXA', 0], 0x8B: ['PHB', 0], 0x8C: ['STY', 2],
  0x8D: ['STA', 2], 0x8E: ['STX', 2], 0x8F: ['STA lng', 3],
  0x90: ['BCC', 1], 0x98: ['TYA', 0], 0x99: ['STA,Y', 2], 0x9A: ['TXS', 0],
  0x9C: ['STZ', 2], 0x9E: ['STZ,X', 2], 0x9F: ['STA lng,X', 3],
  0xA0: ['LDY#', 1], 0xA1: ['LDA(dp,X)', 1], 0xA2: ['LDX#', 1],
  0xA4: ['LDY dp', 1], 0xA5: ['LDA dp', 1], 0xA6: ['LDX dp', 1],
  0xA8: ['TAY', 0], 0xA9: ['LDA#', 1], 0xAA: ['TAX', 0], 0xAB: ['PLB', 0],
  0xAC: ['LDY', 2], 0xAD: ['LDA', 2], 0xAE: ['LDX', 2], 0xAF: ['LDA lng', 3],
  0xB0: ['BCS', 1], 0xB1: ['LDA(dp),Y', 1], 0xB2: ['LDA(dp)', 1],
  0xB4: ['LDY dp,X', 1], 0xB5: ['LDA dp,X', 1], 0xB6: ['LDX dp,Y', 1],
  0xB7: ['LDA[dp],Y', 1], 0xB8: ['CLV', 0], 0xB9: ['LDA,Y', 2],
  0xBA: ['TSX', 0], 0xBB: ['TYX', 0], 0xBC: ['LDY,X', 2],
  0xBD: ['LDA,X', 2], 0xBE: ['LDX,Y', 2], 0xBF: ['LDA lng,X', 3],
  0xC0: ['CPY#', 1], 0xC2: ['REP', 1], 0xC4: ['CPY dp', 1],
  0xC8: ['INY', 0], 0xC9: ['CMP#', 1], 0xCA: ['DEX', 0],
  0xCC: ['CPY', 2], 0xCD: ['CMP', 2], 0xD0: ['BNE', 1], 0xD2: ['CMP(dp)', 1],
  0xDA: ['PHX', 0], 0xDB: ['STP', 0],
  0xE0: ['CPX#', 1], 0xE2: ['SEP', 1], 0xE6: ['INC dp', 1],
  0xE8: ['INX', 0], 0xE9: ['SBC#', 1], 0xEA: ['NOP', 0], 0xEB: ['XBA', 0],
  0xEE: ['INC', 2], 0xF0: ['BEQ', 1], 0xF4: ['PEA', 2], 0xFA: ['PLX', 0],
  0xFB: ['XCE', 0],
}

function disasm(buf, startOff, count, hasHeader) {
  let off = startOff
  const lines = []
  for (let i = 0; i < count && off < buf.length; i++) {
    const snes = toSnes(off, hasHeader)
    const op = buf[off]
    const info = OP[op]
    if (!info) {
      lines.push(`  $${hex(snes, 6)}  ${hex(op)}              ???`)
      off++
      continue
    }
    const [mnem, extra] = info
    let operand = ''
    let val = 0
    if (extra === 1) {
      val = buf[off + 1]
      operand = `$${hex(val)}`
    } else if (extra === 2) {
      val = buf[off + 1] | (buf[off + 2] << 8)
      operand = `$${hex(val, 4)}`
    } else if (extra === 3) {
      val = buf[off + 1] | (buf[off + 2] << 8) | (buf[off + 3] << 16)
      operand = `$${hex(val, 6)}`
    }
    // Annotate branches
    let annotation = ''
    if (extra === 1 && (mnem.startsWith('B') && mnem !== 'BRK' && mnem !== 'BIT#')) {
      const rel = val < 0x80 ? val : val - 0x100
      const target = toSnes(off + 2 + rel, hasHeader)
      annotation = ` → $${hex(target, 6)}`
    }
    const raw = [...buf.slice(off, off + 1 + extra)].map(b => hex(b)).join(' ').padEnd(12)
    lines.push(`  $${hex(snes, 6)}  ${raw}  ${mnem.padEnd(12)} ${operand}${annotation}`)
    off += 1 + extra
  }
  return lines
}

// ── Main analysis ─────────────────────────────────────────────────────────────

const romPath = process.argv[2]
if (!romPath) {
  console.error('Usage: node scripts/trace-ec7b.mjs <rom.sfc>')
  process.exit(1)
}

const { buf, hasHeader } = loadRom(romPath)
console.log(`ROM:  ${romPath}`)
console.log(`Size: ${buf.length} | Header: ${hasHeader ? 'yes ($200)' : 'no'}\n`)

// ── Disassemble $00EB7B – $00EE00 (large window around EC7B) ─────────────────
const EB7B = fileOffset(0x00EB7B, hasHeader)
console.log('='.repeat(70))
console.log(`SNES $00EB7B...$00EE00 — overworld name code context (file $${hex(EB7B,6)})`)
console.log('='.repeat(70))
const lines = disasm(buf, EB7B, 180, hasHeader)
lines.forEach(l => console.log(l))
console.log()

// ── Focus: Find all table loads in that region ────────────────────────────────
console.log('='.repeat(70))
console.log('Table loads (LDA/LDX/LDY with ,X or ,Y or long) in $00EB7B–$00EE00')
console.log('='.repeat(70))
const endOff = fileOffset(0x00EE00, hasHeader)
for (let off = EB7B; off < endOff; off++) {
  const op = buf[off]
  if (op === 0xBF || op === 0xAF) {
    const addr = buf[off+1] | (buf[off+2] << 8) | (buf[off+3] << 16)
    const fOff = fileOffset(addr, hasHeader)
    const snes = toSnes(off, hasHeader)
    const preview = fOff < buf.length ? [...buf.slice(fOff, fOff+8)].map(b=>hex(b)).join(' ') : '?'
    console.log(`  $${hex(snes,6)}: LDA $${hex(addr,6)}${op===0xBF?',X':''} → file $${hex(fOff,6)} → [${preview}]`)
  } else if (op === 0xBD || op === 0xB9 || op === 0xBC || op === 0xBE || op === 0x9F || op === 0x3F) {
    const addr = buf[off+1] | (buf[off+2] << 8)
    const snes = toSnes(off, hasHeader)
    const mnem = {0xBD:'LDA,X',0xB9:'LDA,Y',0xBC:'LDY,X',0xBE:'LDX,Y',0x9F:'STA,X',0x3F:'LDA,X'}[op]
    console.log(`  $${hex(snes,6)}: ${mnem} $${hex(addr,4)}`)
  }
}
console.log()

// ── Also disassemble the subroutine called from EC7B toward the render ────────
// The main render entry: find JSL/JSR targets

console.log('='.repeat(70))
console.log('Subroutine call targets in $00EB7B–$00EE00:')
console.log('='.repeat(70))
for (let off = EB7B; off < endOff; off++) {
  const op = buf[off]
  if (op === 0x22 || op === 0x20) {
    const addr = op === 0x22
      ? buf[off+1] | (buf[off+2] << 8) | (buf[off+3] << 16)
      : buf[off+1] | (buf[off+2] << 8)
    const snes = toSnes(off, hasHeader)
    const mnem = op === 0x22 ? 'JSL' : 'JSR'
    const fOff = fileOffset(addr, hasHeader)
    console.log(`  $${hex(snes,6)}: ${mnem} $${hex(addr,6)} (file $${hex(fOff,6)})`)
    // Disassemble first 8 instructions of the called routine
    const sub = disasm(buf, fOff, 12, hasHeader)
    sub.forEach(l => console.log('    ' + l.trim()))
    console.log()
  }
}

// ── Find what routine calls $00F127 ──────────────────────────────────────────
console.log('='.repeat(70))
console.log('All JSL $00F127 call sites in bank $00:')
console.log('='.repeat(70))
const base = hasHeader ? COPIER_HEADER : 0
const bankEnd = base + 0x8000
for (let off = base; off < bankEnd - 3; off++) {
  if (buf[off] === 0x22 && buf[off+1] === 0x27 && buf[off+2] === 0xF1 && buf[off+3] === 0x00) {
    const snes = toSnes(off, hasHeader)
    // Show context
    const ctx = disasm(buf, Math.max(off-16, base), 14, hasHeader)
    console.log(`  Found JSL $00F127 at SNES $${hex(snes,6)} (file $${hex(off,6)}):`)
    ctx.forEach(l => console.log(l))
    console.log()
  }
}

console.log('Done.')
