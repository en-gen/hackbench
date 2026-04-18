/**
 * Simple 65816 disassembler for SMW ROM analysis.
 * Handles 8-bit accumulator/index mode (SEP #$30 context).
 *
 * Usage: npx tsx tools/disasm.ts <snesAddr> [length] [--16bit]
 *   snesAddr: SNES address in hex (e.g. 0587FF or 0DA8C3)
 *   length:   bytes to disassemble (default 128)
 *   --16bit:  start in 16-bit accumulator mode
 *
 * Example: npx tsx tools/disasm.ts 0587FF 200
 */

import * as fs from 'fs'

const ROM_PATH = 'test/roms/Super Mario World (USA).vanilla.sfc'

interface Op { n: string; l: number; m?: string }

const OPS: Record<number, Op> = {
  0x00: { n: 'BRK', l: 2 }, 0x01: { n: 'ORA', l: 2, m: '(dp,X)' },
  0x02: { n: 'COP', l: 2 }, 0x03: { n: 'ORA', l: 2, m: 'sr,S' },
  0x05: { n: 'ORA', l: 2, m: 'dp' }, 0x06: { n: 'ASL', l: 2, m: 'dp' },
  0x07: { n: 'ORA', l: 2, m: '[dp]' }, 0x08: { n: 'PHP', l: 1 },
  0x09: { n: 'ORA', l: 2, m: '#imm' }, 0x0A: { n: 'ASL A', l: 1 },
  0x0B: { n: 'PHD', l: 1 }, 0x0D: { n: 'ORA', l: 3, m: 'abs' },
  0x0E: { n: 'ASL', l: 3, m: 'abs' }, 0x0F: { n: 'ORA', l: 4, m: 'long' },
  0x10: { n: 'BPL', l: 2, m: 'rel' }, 0x11: { n: 'ORA', l: 2, m: '(dp),Y' },
  0x12: { n: 'ORA', l: 2, m: '(dp)' }, 0x13: { n: 'ORA', l: 2, m: '(sr,S),Y' },
  0x15: { n: 'ORA', l: 2, m: 'dp,X' }, 0x16: { n: 'ASL', l: 2, m: 'dp,X' },
  0x17: { n: 'ORA', l: 2, m: '[dp],Y' }, 0x18: { n: 'CLC', l: 1 },
  0x19: { n: 'ORA', l: 3, m: 'abs,Y' }, 0x1A: { n: 'INC A', l: 1 },
  0x1B: { n: 'TCS', l: 1 }, 0x1C: { n: 'TRB', l: 3, m: 'abs' },
  0x1D: { n: 'ORA', l: 3, m: 'abs,X' },
  0x20: { n: 'JSR', l: 3, m: 'abs' }, 0x22: { n: 'JSL', l: 4, m: 'long' },
  0x24: { n: 'BIT', l: 2, m: 'dp' }, 0x25: { n: 'AND', l: 2, m: 'dp' },
  0x26: { n: 'ROL', l: 2, m: 'dp' }, 0x28: { n: 'PLP', l: 1 },
  0x29: { n: 'AND', l: 2, m: '#imm' }, 0x2A: { n: 'ROL A', l: 1 },
  0x2B: { n: 'PLD', l: 1 }, 0x2C: { n: 'BIT', l: 3, m: 'abs' },
  0x2D: { n: 'AND', l: 3, m: 'abs' }, 0x2F: { n: 'AND', l: 4, m: 'long' },
  0x30: { n: 'BMI', l: 2, m: 'rel' }, 0x31: { n: 'AND', l: 2, m: '(dp),Y' },
  0x33: { n: 'AND', l: 2, m: '(sr,S),Y' }, 0x35: { n: 'AND', l: 2, m: 'dp,X' },
  0x38: { n: 'SEC', l: 1 }, 0x39: { n: 'AND', l: 3, m: 'abs,Y' },
  0x3A: { n: 'DEC A', l: 1 }, 0x3B: { n: 'TSC', l: 1 },
  0x3D: { n: 'AND', l: 3, m: 'abs,X' }, 0x3F: { n: 'AND', l: 4, m: 'long,X' },
  0x40: { n: 'RTI', l: 1 }, 0x41: { n: 'EOR', l: 2, m: '(dp,X)' },
  0x45: { n: 'EOR', l: 2, m: 'dp' }, 0x46: { n: 'LSR', l: 2, m: 'dp' },
  0x47: { n: 'EOR', l: 2, m: '[dp]' }, 0x48: { n: 'PHA', l: 1 },
  0x49: { n: 'EOR', l: 2, m: '#imm' }, 0x4A: { n: 'LSR A', l: 1 },
  0x4B: { n: 'PHK', l: 1 }, 0x4C: { n: 'JMP', l: 3, m: 'abs' },
  0x4D: { n: 'EOR', l: 3, m: 'abs' },
  0x50: { n: 'BVC', l: 2, m: 'rel' }, 0x51: { n: 'EOR', l: 2, m: '(dp),Y' },
  0x52: { n: 'EOR', l: 2, m: '(dp)' },
  0x55: { n: 'EOR', l: 2, m: 'dp,X' }, 0x58: { n: 'CLI', l: 1 },
  0x59: { n: 'EOR', l: 3, m: 'abs,Y' }, 0x5A: { n: 'PHY', l: 1 },
  0x5B: { n: 'TCD', l: 1 }, 0x5C: { n: 'JML', l: 4, m: 'long' },
  0x5D: { n: 'EOR', l: 3, m: 'abs,X' },
  0x60: { n: 'RTS', l: 1 }, 0x61: { n: 'ADC', l: 2, m: '(dp,X)' },
  0x64: { n: 'STZ', l: 2, m: 'dp' }, 0x65: { n: 'ADC', l: 2, m: 'dp' },
  0x66: { n: 'ROR', l: 2, m: 'dp' }, 0x68: { n: 'PLA', l: 1 },
  0x69: { n: 'ADC', l: 2, m: '#imm' }, 0x6A: { n: 'ROR A', l: 1 },
  0x6B: { n: 'RTL', l: 1 }, 0x6C: { n: 'JMP', l: 3, m: '(abs)' },
  0x6D: { n: 'ADC', l: 3, m: 'abs' },
  0x70: { n: 'BVS', l: 2, m: 'rel' }, 0x71: { n: 'ADC', l: 2, m: '(dp),Y' },
  0x75: { n: 'ADC', l: 2, m: 'dp,X' }, 0x78: { n: 'SEI', l: 1 },
  0x79: { n: 'ADC', l: 3, m: 'abs,Y' }, 0x7A: { n: 'PLY', l: 1 },
  0x7B: { n: 'TDC', l: 1 }, 0x7C: { n: 'JMP', l: 3, m: '(abs,X)' },
  0x7D: { n: 'ADC', l: 3, m: 'abs,X' },
  0x80: { n: 'BRA', l: 2, m: 'rel' }, 0x81: { n: 'STA', l: 2, m: '(dp,X)' },
  0x84: { n: 'STY', l: 2, m: 'dp' }, 0x85: { n: 'STA', l: 2, m: 'dp' },
  0x86: { n: 'STX', l: 2, m: 'dp' }, 0x87: { n: 'STA', l: 2, m: '[dp]' },
  0x88: { n: 'DEY', l: 1 }, 0x89: { n: 'BIT', l: 2, m: '#imm' },
  0x8A: { n: 'TXA', l: 1 }, 0x8B: { n: 'PHB', l: 1 },
  0x8C: { n: 'STY', l: 3, m: 'abs' }, 0x8D: { n: 'STA', l: 3, m: 'abs' },
  0x8E: { n: 'STX', l: 3, m: 'abs' },
  0x90: { n: 'BCC', l: 2, m: 'rel' }, 0x91: { n: 'STA', l: 2, m: '(dp),Y' },
  0x92: { n: 'STA', l: 2, m: '(dp)' }, 0x94: { n: 'STY', l: 2, m: 'dp,X' },
  0x95: { n: 'STA', l: 2, m: 'dp,X' }, 0x96: { n: 'STX', l: 2, m: 'dp,Y' },
  0x97: { n: 'STA', l: 2, m: '[dp],Y' }, 0x98: { n: 'TYA', l: 1 },
  0x99: { n: 'STA', l: 3, m: 'abs,Y' }, 0x9A: { n: 'TXS', l: 1 },
  0x9B: { n: 'TXY', l: 1 }, 0x9C: { n: 'STZ', l: 3, m: 'abs' },
  0x9D: { n: 'STA', l: 3, m: 'abs,X' }, 0x9E: { n: 'STZ', l: 3, m: 'abs,X' },
  0xA0: { n: 'LDY', l: 2, m: '#imm' }, 0xA1: { n: 'LDA', l: 2, m: '(dp,X)' },
  0xA2: { n: 'LDX', l: 2, m: '#imm' }, 0xA4: { n: 'LDY', l: 2, m: 'dp' },
  0xA5: { n: 'LDA', l: 2, m: 'dp' }, 0xA6: { n: 'LDX', l: 2, m: 'dp' },
  0xA8: { n: 'TAY', l: 1 }, 0xA9: { n: 'LDA', l: 2, m: '#imm' },
  0xAA: { n: 'TAX', l: 1 }, 0xAB: { n: 'PLB', l: 1 },
  0xAC: { n: 'LDY', l: 3, m: 'abs' }, 0xAD: { n: 'LDA', l: 3, m: 'abs' },
  0xAE: { n: 'LDX', l: 3, m: 'abs' }, 0xAF: { n: 'LDA', l: 4, m: 'long' },
  0xB0: { n: 'BCS', l: 2, m: 'rel' }, 0xB1: { n: 'LDA', l: 2, m: '(dp),Y' },
  0xB2: { n: 'LDA', l: 2, m: '(dp)' }, 0xB4: { n: 'LDY', l: 2, m: 'dp,X' },
  0xB5: { n: 'LDA', l: 2, m: 'dp,X' }, 0xB7: { n: 'LDA', l: 2, m: '[dp],Y' },
  0xB9: { n: 'LDA', l: 3, m: 'abs,Y' }, 0xBB: { n: 'TYX', l: 1 },
  0xBD: { n: 'LDA', l: 3, m: 'abs,X' }, 0xBF: { n: 'LDA', l: 4, m: 'long,X' },
  0xC0: { n: 'CPY', l: 2, m: '#imm' }, 0xC1: { n: 'CMP', l: 2, m: '(dp,X)' },
  0xC2: { n: 'REP', l: 2, m: '#imm' }, 0xC4: { n: 'CPY', l: 2, m: 'dp' },
  0xC5: { n: 'CMP', l: 2, m: 'dp' }, 0xC6: { n: 'DEC', l: 2, m: 'dp' },
  0xC8: { n: 'INY', l: 1 }, 0xC9: { n: 'CMP', l: 2, m: '#imm' },
  0xCA: { n: 'DEX', l: 1 }, 0xCB: { n: 'WAI', l: 1 },
  0xCC: { n: 'CPY', l: 3, m: 'abs' }, 0xCD: { n: 'CMP', l: 3, m: 'abs' },
  0xCE: { n: 'DEC', l: 3, m: 'abs' }, 0xCF: { n: 'CMP', l: 4, m: 'long' },
  0xD0: { n: 'BNE', l: 2, m: 'rel' }, 0xD1: { n: 'CMP', l: 2, m: '(dp),Y' },
  0xD5: { n: 'CMP', l: 2, m: 'dp,X' }, 0xD6: { n: 'DEC', l: 2, m: 'dp,X' },
  0xD8: { n: 'CLD', l: 1 }, 0xD9: { n: 'CMP', l: 3, m: 'abs,Y' },
  0xDA: { n: 'PHX', l: 1 }, 0xDB: { n: 'STP', l: 1 },
  0xDD: { n: 'CMP', l: 3, m: 'abs,X' }, 0xDE: { n: 'DEC', l: 3, m: 'abs,X' },
  0xDF: { n: 'CMP', l: 4, m: 'long,X' },
  0xE0: { n: 'CPX', l: 2, m: '#imm' }, 0xE2: { n: 'SEP', l: 2, m: '#imm' },
  0xE4: { n: 'CPX', l: 2, m: 'dp' }, 0xE5: { n: 'SBC', l: 2, m: 'dp' },
  0xE6: { n: 'INC', l: 2, m: 'dp' }, 0xE8: { n: 'INX', l: 1 },
  0xE9: { n: 'SBC', l: 2, m: '#imm' }, 0xEA: { n: 'NOP', l: 1 },
  0xEB: { n: 'XBA', l: 1 }, 0xEC: { n: 'CPX', l: 3, m: 'abs' },
  0xED: { n: 'SBC', l: 3, m: 'abs' }, 0xEE: { n: 'INC', l: 3, m: 'abs' },
  0xEF: { n: 'SBC', l: 4, m: 'long' },
  0xF0: { n: 'BEQ', l: 2, m: 'rel' }, 0xF1: { n: 'SBC', l: 2, m: '(dp),Y' },
  0xF4: { n: 'PEA', l: 3, m: 'abs' }, 0xF5: { n: 'SBC', l: 2, m: 'dp,X' },
  0xF6: { n: 'INC', l: 2, m: 'dp,X' }, 0xFA: { n: 'PLX', l: 1 },
  0xFB: { n: 'XCE', l: 1 }, 0xFC: { n: 'JSR', l: 3, m: '(abs,X)' },
  0xFD: { n: 'SBC', l: 3, m: 'abs,X' }, 0xFE: { n: 'INC', l: 3, m: 'abs,X' },
  0xFF: { n: 'SBC', l: 4, m: 'long,X' },
}

function loromOffset(snesAddr: number, headerSize: number): number {
  const bank = (snesAddr >> 16) & 0x7F
  const addr = snesAddr & 0x7FFF
  return bank * 0x8000 + addr + headerSize
}

function formatOperand(op: Op, rom: Buffer, pos: number, snesAddr: number): string {
  const b1 = rom[pos + 1], b2 = rom[pos + 2], b3 = rom[pos + 3]
  const m = op.m
  if (!m) return ''
  if (m === 'rel') {
    const off = b1 > 127 ? b1 - 256 : b1
    return ` $${(snesAddr + 2 + off).toString(16).padStart(6, '0')}`
  }
  if (m === '#imm') return ` #$${b1.toString(16).padStart(2, '0')}`
  if (m === 'dp') return ` $${b1.toString(16).padStart(2, '0')}`
  if (m === 'dp,X') return ` $${b1.toString(16).padStart(2, '0')},X`
  if (m === 'dp,Y') return ` $${b1.toString(16).padStart(2, '0')},Y`
  if (m === '(dp)') return ` ($${b1.toString(16).padStart(2, '0')})`
  if (m === '(dp,X)') return ` ($${b1.toString(16).padStart(2, '0')},X)`
  if (m === '(dp),Y') return ` ($${b1.toString(16).padStart(2, '0')}),Y`
  if (m === '[dp]') return ` [$${b1.toString(16).padStart(2, '0')}]`
  if (m === '[dp],Y') return ` [$${b1.toString(16).padStart(2, '0')}],Y`
  if (m === 'sr,S') return ` $${b1.toString(16).padStart(2, '0')},S`
  if (m === '(sr,S),Y') return ` ($${b1.toString(16).padStart(2, '0')},S),Y`
  if (m === 'abs') return ` $${(b1 | b2 << 8).toString(16).padStart(4, '0')}`
  if (m === 'abs,X') return ` $${(b1 | b2 << 8).toString(16).padStart(4, '0')},X`
  if (m === 'abs,Y') return ` $${(b1 | b2 << 8).toString(16).padStart(4, '0')},Y`
  if (m === '(abs)') return ` ($${(b1 | b2 << 8).toString(16).padStart(4, '0')})`
  if (m === '(abs,X)') return ` ($${(b1 | b2 << 8).toString(16).padStart(4, '0')},X)`
  if (m === 'long') return ` $${(b1 | b2 << 8 | b3 << 16).toString(16).padStart(6, '0')}`
  if (m === 'long,X') return ` $${(b1 | b2 << 8 | b3 << 16).toString(16).padStart(6, '0')},X`
  return ''
}

// Instructions affected by 16-bit accumulator mode (REP #$20)
const IMM_A_OPS = new Set([0x09, 0x29, 0x49, 0x69, 0x89, 0xA9, 0xC9, 0xE9])
// Instructions affected by 16-bit index mode (REP #$10)
const IMM_XY_OPS = new Set([0xA0, 0xA2, 0xC0, 0xE0])

function disassemble(rom: Buffer, snesStart: number, len: number, startA16 = false, startXY16 = false): string[] {
  // Detect copier header: check for ROM internal name at headerless vs headered offsets
  // LoROM: SNES $00FFC0 → file offset $7FC0 (no header) or $81C0 (with 512-byte header)
  const nameNoHeader = rom.slice(0x7FC0, 0x7FC0 + 16).toString('ascii')
  const nameWithHeader = rom.slice(0x81C0, 0x81C0 + 16).toString('ascii')
  let headerSize = 0
  if (nameWithHeader.startsWith('SUPER MARIO') && !nameNoHeader.startsWith('SUPER MARIO')) {
    headerSize = 0x200
  }
  const fileStart = loromOffset(snesStart, headerSize)
  const lines: string[] = []
  let pos = fileStart
  const end = fileStart + len
  let a16 = startA16   // accumulator 16-bit mode
  let xy16 = startXY16 // index register 16-bit mode

  while (pos < end && pos < rom.length) {
    const opcode = rom[pos]
    const op = OPS[opcode]
    const addr = snesStart + (pos - fileStart)

    if (!op) {
      const hex = rom[pos].toString(16).padStart(2, '0')
      lines.push(`${addr.toString(16).padStart(6, '0')}:  ${hex.padEnd(12)} .db $${hex}`)
      pos++
      continue
    }

    // Compute actual instruction length accounting for 16-bit immediate modes
    let actualLen = op.l
    if (op.m === '#imm') {
      if (IMM_A_OPS.has(opcode) && a16) actualLen = 3  // 16-bit immediate
      if (IMM_XY_OPS.has(opcode) && xy16) actualLen = 3
    }

    const hex = Array.from(rom.slice(pos, pos + actualLen))
      .map(b => b.toString(16).padStart(2, '0')).join(' ')

    // Format operand with correct width
    let operand = ''
    if (op.m === '#imm' && actualLen === 3) {
      const w = rom[pos + 1] | (rom[pos + 2] << 8)
      operand = ` #$${w.toString(16).padStart(4, '0')}`
    } else {
      operand = formatOperand(op, rom, pos, addr)
    }

    lines.push(`${addr.toString(16).padStart(6, '0')}:  ${hex.padEnd(12)} ${op.n}${operand}`)

    // Track SEP/REP mode changes
    if (opcode === 0xE2) { // SEP — set bits = 8-bit
      const flags = rom[pos + 1]
      if (flags & 0x20) a16 = false   // M flag → 8-bit accumulator
      if (flags & 0x10) xy16 = false  // X flag → 8-bit index
    } else if (opcode === 0xC2) { // REP — clear bits = 16-bit
      const flags = rom[pos + 1]
      if (flags & 0x20) a16 = true    // M flag → 16-bit accumulator
      if (flags & 0x10) xy16 = true   // X flag → 16-bit index
    }

    if (['RTS', 'RTL', 'RTI', 'BRA', 'JML'].includes(op.n)) lines.push('')
    pos += actualLen
  }
  return lines
}

// --- Main ---
const args = process.argv.slice(2)
if (args.length < 1) {
  console.log('Usage: npx tsx tools/disasm.ts <snesAddr> [length]')
  console.log('  snesAddr: hex SNES address (e.g. 0587FF)')
  console.log('  length:   bytes to disassemble (default 128)')
  process.exit(1)
}

const snesAddr = parseInt(args[0], 16)
const len = parseInt(args[1] || '128', 10)
const startA16 = args.includes('--a16')
const startXY16 = args.includes('--xy16')
const rom = fs.readFileSync(ROM_PATH)
const lines = disassemble(rom, snesAddr, len, startA16, startXY16)
lines.forEach(l => console.log(l))
