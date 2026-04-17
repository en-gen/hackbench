/**
 * Disassemble a SMW handler and show instruction offsets.
 * Usage: node scripts/disasm-handler.mjs <romPath> <snesAddr> [lengthBytes]
 *
 * 65816-SEP#$30 (A/X/Y 8-bit) mode. Walks forward until RTS/RTL/BRL or length
 * runs out. For each instruction prints:
 *   offset-from-start  hex-bytes  mnemonic  operand-description
 */

import { readFileSync } from 'fs'

const romPath = process.argv[2]
const addrStr = process.argv[3]
const lenArg  = process.argv[4]
if (!romPath || !addrStr) {
  console.error('Usage: node disasm-handler.mjs <rom> <snesAddr-hex> [len]')
  process.exit(1)
}
const startAddr = parseInt(addrStr, 16)
const maxLen = lenArg ? parseInt(lenArg, 16) : 0x100

const buf = readFileSync(romPath)
const hdrOff = (buf.length % 1024) === 512 ? 512 : 0
const loromOff = s => hdrOff + ((s>>>16) & 0x7F) * 0x8000 + ((s & 0xFFFF) - 0x8000)

function byte(addr) { return buf[loromOff(addr)] }

// 65816 opcode table (SEP#$30 mode): {size, fmt}
// size = total bytes incl. opcode byte; fmt = how to render operand(s)
const OPCODES = {
  0x00: [2, 'BRK',        'imm'],
  0x08: [1, 'PHP',        null],
  0x0A: [1, 'ASL A',      null],
  0x18: [1, 'CLC',        null],
  0x20: [3, 'JSR',        'abs'],
  0x22: [4, 'JSL',        'long'],
  0x28: [1, 'PLP',        null],
  0x29: [2, 'AND',        'imm'],
  0x2A: [1, 'ROL A',      null],
  0x2C: [3, 'BIT',        'abs'],
  0x30: [2, 'BMI',        'rel'],
  0x38: [1, 'SEC',        null],
  0x40: [1, 'RTI',        null],
  0x48: [1, 'PHA',        null],
  0x4A: [1, 'LSR A',      null],
  0x4C: [3, 'JMP',        'abs'],
  0x5A: [1, 'PHY',        null],
  0x5C: [4, 'JML',        'long'],
  0x60: [1, 'RTS',        null],
  0x62: [3, 'PER',        'rel16'],
  0x68: [1, 'PLA',        null],
  0x69: [2, 'ADC',        'imm'],
  0x6A: [1, 'ROR A',      null],
  0x6B: [1, 'RTL',        null],
  0x7A: [1, 'PLY',        null],
  0x80: [2, 'BRA',        'rel'],
  0x82: [3, 'BRL',        'rel16'],
  0x84: [2, 'STY',        'dp'],
  0x85: [2, 'STA',        'dp'],
  0x86: [2, 'STX',        'dp'],
  0x88: [1, 'DEY',        null],
  0x8A: [1, 'TXA',        null],
  0x8D: [3, 'STA',        'abs'],
  0x8F: [4, 'STA.L',      'long'],
  0x90: [2, 'BCC',        'rel'],
  0x97: [2, 'STA',        '[dp],Y'],
  0x98: [1, 'TYA',        null],
  0x9C: [3, 'STZ',        'abs'],
  0xA0: [2, 'LDY',        'imm'],
  0xA2: [2, 'LDX',        'imm'],
  0xA4: [2, 'LDY',        'dp'],
  0xA5: [2, 'LDA',        'dp'],
  0xA6: [2, 'LDX',        'dp'],
  0xA8: [1, 'TAY',        null],
  0xA9: [2, 'LDA',        'imm'],
  0xAA: [1, 'TAX',        null],
  0xAD: [3, 'LDA',        'abs'],
  0xAE: [3, 'LDX',        'abs'],
  0xAF: [4, 'LDA.L',      'long'],
  0xB0: [2, 'BCS',        'rel'],
  0xB5: [2, 'LDA',        'dp,X'],
  0xB7: [2, 'LDA',        '[dp],Y'],
  0xB9: [3, 'LDA',        'abs,Y'],
  0xBD: [3, 'LDA',        'abs,X'],
  0xBF: [4, 'LDA.L',      'long,X'],
  0xC0: [2, 'CPY',        'imm'],
  0xC6: [2, 'DEC',        'dp'],
  0xC8: [1, 'INY',        null],
  0xC9: [2, 'CMP',        'imm'],
  0xCA: [1, 'DEX',        null],
  0xD0: [2, 'BNE',        'rel'],
  0xDA: [1, 'PHX',        null],
  0xE0: [2, 'CPX',        'imm'],
  0xE2: [2, 'SEP',        'imm'],
  0xE6: [2, 'INC',        'dp'],
  0xE8: [1, 'INX',        null],
  0xE9: [2, 'SBC',        'imm'],
  0xEA: [1, 'NOP',        null],
  0xF0: [2, 'BEQ',        'rel'],
  0xFA: [1, 'PLX',        null],
  0x0D: [3, 'ORA',        'abs'],
  0x1D: [3, 'ORA',        'abs,X'],
  0x2D: [3, 'AND',        'abs'],
  0x4D: [3, 'EOR',        'abs'],
  0x6D: [3, 'ADC',        'abs'],
  0x7D: [3, 'ADC',        'abs,X'],
  0x7F: [4, 'ADC.L',      'long,X'],
  0x9D: [3, 'STA',        'abs,X'],
  0x9F: [4, 'STA.L',      'long,X'],
  0xBE: [3, 'LDX',        'abs,Y'],
  0xBC: [3, 'LDY',        'abs,X'],
  0xCD: [3, 'CMP',        'abs'],
  0xDD: [3, 'CMP',        'abs,X'],
  0xED: [3, 'SBC',        'abs'],
  0xFD: [3, 'SBC',        'abs,X'],
  0xEE: [3, 'INC',        'abs'],
  0xCE: [3, 'DEC',        'abs'],
  0x0E: [3, 'ASL',        'abs'],
  0x4E: [3, 'LSR',        'abs'],
  0x2E: [3, 'ROL',        'abs'],
  0x6E: [3, 'ROR',        'abs'],
  0x4B: [1, 'PHK',        null],
  0xAB: [1, 'PLB',        null],
  0x8B: [1, 'PHB',        null],
  0x7B: [1, 'TDC',        null],
  0xE3: [2, 'SBC',        'dp,S'],
  0x03: [2, 'ORA',        'dp,S'],
  0x63: [2, 'ADC',        'dp,S'],
}

const TERMS = new Set([0x60, 0x6B, 0x40])  // RTS, RTL, RTI (end of routine)

let pc = startAddr
const end = startAddr + maxLen
while (pc < end) {
  const op = byte(pc)
  const entry = OPCODES[op]
  if (!entry) {
    const o = pc - startAddr
    console.log(`+${o.toString().padStart(3)}  ${op.toString(16).padStart(2,'0')}        ???`)
    pc += 1
    continue
  }
  const [size, mnem, fmt] = entry
  const bytes = []
  for (let i = 0; i < size; i++) bytes.push(byte(pc + i))
  const hex = bytes.map(b => b.toString(16).padStart(2,'0')).join(' ')
  let operand = ''
  switch (fmt) {
    case 'imm':    operand = `#$${bytes[1].toString(16).padStart(2,'0').toUpperCase()}`; break
    case 'dp':     operand = `$${bytes[1].toString(16).padStart(2,'0').toUpperCase()}`; break
    case 'dp,X':   operand = `$${bytes[1].toString(16).padStart(2,'0').toUpperCase()},X`; break
    case '[dp],Y': operand = `[$${bytes[1].toString(16).padStart(2,'0').toUpperCase()}],Y`; break
    case 'abs':    operand = `$${((bytes[2] << 8) | bytes[1]).toString(16).padStart(4,'0').toUpperCase()}`; break
    case 'abs,X':  operand = `$${((bytes[2] << 8) | bytes[1]).toString(16).padStart(4,'0').toUpperCase()},X`; break
    case 'abs,Y':  operand = `$${((bytes[2] << 8) | bytes[1]).toString(16).padStart(4,'0').toUpperCase()},Y`; break
    case 'long':   operand = `$${((bytes[3]<<16)|(bytes[2]<<8)|bytes[1]).toString(16).padStart(6,'0').toUpperCase()}`; break
    case 'long,X': operand = `$${((bytes[3]<<16)|(bytes[2]<<8)|bytes[1]).toString(16).padStart(6,'0').toUpperCase()},X`; break
    case 'rel': {
      const off = bytes[1] < 0x80 ? bytes[1] : bytes[1] - 0x100
      operand = `$${(pc + 2 + off).toString(16).padStart(6,'0').toUpperCase()}`
      break
    }
    case 'rel16': {
      const off = (bytes[2] << 8) | bytes[1]
      const signed = off < 0x8000 ? off : off - 0x10000
      operand = `$${(pc + 3 + signed).toString(16).padStart(6,'0').toUpperCase()}`
      break
    }
  }
  const o = pc - startAddr
  console.log(`+${o.toString().padStart(3)}  ${hex.padEnd(12)}  ${mnem.padEnd(6)} ${operand}`)
  pc += size
  if (TERMS.has(op)) break
}
