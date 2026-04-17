/**
 * Audit: for each offset referenced in handler ports, print what the byte
 * at that offset actually is in the ROM. An immediate operand offset should
 * point at a tile ID (varied value). An opcode offset would always be $A9
 * (for LDA #) or $BF (for LDA.L,X).
 */
import { readFileSync } from 'fs'

const buf = readFileSync('C:/Users/engenb/Super Mario World (USA).sfc')
const off = s => ((s>>>16)&0x7F)*0x8000 + ((s&0xFFFF)-0x8000)
const byte = (base, o) => buf[off(base) + o]

const refs = [
  // [handler address, offset, label, expected kind]
  // 0DA8C3
  [0x0DA8C3, 108, 'DATA_0DA8B4 operand', 'operand3'],
  // 0DAA26
  [0x0DAA26,  26, 'DATA_0DAA12 operand', 'operand3'],
  [0x0DAA26,  36, 'DATA_0DAA17 operand', 'operand3'],
  [0x0DAA26, 110, 'DATA_0DAA1C operand', 'operand3'],
  [0x0DAA26, 120, 'DATA_0DAA21 operand', 'operand3'],
  [0x0DAA26,  52, 'imm $68', 'imm'],
  [0x0DAA26,  60, 'imm $69', 'imm'],
  [0x0DAA26,  70, 'imm $35', 'imm'],
  [0x0DAA26,  78, 'imm $36', 'imm'],
  // 0DAAB4
  [0x0DAAB4,  29, 'DATA_0DAAA4 operand', 'operand3'],
  [0x0DAAB4,  42, 'DATA_0DAAAC operand', 'operand3'],
  // 0DAB0D
  [0x0DAB0D,  13, 'imm $41', 'imm'],
  [0x0DAB0D,  26, 'imm $42', 'imm'],
  [0x0DAB0D,  39, 'imm $43', 'imm'],
  // 0DB3BD
  [0x0DB3BD,  19, 'DATA_0DB3BB operand', 'operand3'],
  // 0DB3E3
  [0x0DB3E3,  30, 'DATA_0DB3DB operand', 'operand3'],
  [0x0DB3E3,  47, 'DATA_0DB3DF operand', 'operand3'],
  // 0DB42D
  [0x0DB42D,  26, 'DATA_0DB42B operand', 'operand3'],
  // 0DB461
  [0x0DB461,  28, 'imm $0B', 'imm'],
  [0x0DB461,  51, 'imm $0E', 'imm'],
  // 0DB51F
  [0x0DB51F,  15, 'imm $53', 'imm'],
  [0x0DB51F,  23, 'imm $54', 'imm'],
  [0x0DB51F,  36, 'imm $55', 'imm'],
  // 0DB547
  [0x0DB547,  11, 'imm $56', 'imm'],
  [0x0DB547,  19, 'imm $57', 'imm'],
  [0x0DB547,  30, 'imm $58', 'imm'],
  // 0DB571
  [0x0DB571,  12, 'DATA_0DB569 operand', 'operand3'],
  // 0DB5B7
  [0x0DB5B7,  19, 'DATA_0DB5A8 operand', 'operand3'],
  [0x0DB5B7,  29, 'DATA_0DB5AD operand', 'operand3'],
  [0x0DB5B7,  43, 'DATA_0DB5B2 operand', 'operand3'],
  // 0DB075
  [0x0DB075,  26, 'DATA_0DB039 operand', 'operand3'],
  [0x0DB075,  60, 'DATA_0DB048 operand', 'operand3'],
  [0x0DB075,  94, 'DATA_0DB057 operand', 'operand3'],
  [0x0DB075, 117, 'DATA_0DB066 operand', 'operand3'],
  [0x0DB075,  30, 'JSR 0DB114 operand', 'jsr2'],
  [0x0DB075,  64, 'JSR 0DB198 operand', 'jsr2'],
  // 0DB224
  [0x0DB224,  24, 'DATA_0DB212 operand', 'operand3'],
  [0x0DB224,  66, 'DATA_0DB215 operand', 'operand3'],
  [0x0DB224, 108, 'DATA_0DB218 operand', 'operand3'],
  [0x0DB224,  34, 'DATA_0DB21B operand', 'operand3'],
  [0x0DB224,  76, 'DATA_0DB21E operand', 'operand3'],
  [0x0DB224, 118, 'DATA_0DB221 operand', 'operand3'],
  // 0DB49E (PoC)
  [0x0DB49E,  16, 'DATA_0DB49C operand', 'operand3'],
  [0x0DB49E,  19, 'JSR 0DB4D9 opcode (whole JSR)', 'jsropcode'],
  [0x0DB49E,  53, 'JMP 0DB4FE operand (inside 0DB4C0 at handler+34+19)', 'jsr2'],
  // 0DB73F
  [0x0DB73F,  11, 'imm $01', 'imm'],
  [0x0DB73F,  27, 'DATA_0DB72F operand', 'operand3'],
  [0x0DB73F, 103, 'imm $EB', 'imm'],
  // 0DB7AA
  [0x0DB7AA,  29, 'imm $AA (fixed)', 'imm'],
  [0x0DB7AA,  37, 'imm $A1 (fixed)', 'imm'],
  [0x0DB7AA,  48, 'imm $AA (fixed)', 'imm'],
  [0x0DB7AA,  57, 'imm $E2 (fixed)', 'imm'],
  [0x0DB7AA,  68, 'imm $3F (fixed)', 'imm'],
  [0x0DB7AA,  79, 'imm $A6 (fixed)', 'imm'],
  [0x0DB7AA, 114, 'imm $F7 (fixed)', 'imm'],
  [0x0DB7AA, 125, 'imm $A3 (fixed)', 'imm'],
  [0x0DB7AA, 136, 'imm $3F (fixed)', 'imm'],
  [0x0DB7AA, 147, 'imm $A6 (fixed)', 'imm'],
  // 0DBA0A
  [0x0DBA0A,  24, 'imm $0E', 'imm'],
  [0x0DBA0A,  38, 'imm $B8', 'imm'],
  // Pipe variants 0-9 (from Batch 6)
  [0x0DAB6E,  27, 'pipe0 imm $96', 'imm'],
  [0x0DAB6E,  35, 'pipe0 imm $9B', 'imm'],
  [0x0DAB6E,  47, 'pipe0 imm $DE', 'imm'],
  [0x0DAB6E,  55, 'pipe0 imm $E6', 'imm'],
  [0x0DAC21,  25, 'pipe1 imm $AA', 'imm'],
  [0x0DAC21,  36, 'pipe1 imm $E2', 'imm'],
  [0x0DAC21,  47, 'pipe1 imm $3F', 'imm'],
  [0x0DAC92,  27, 'pipe2 imm $6E', 'imm'],
  [0x0DAC92,  35, 'pipe2 imm $73', 'imm'],
  [0x0DAC92,  43, 'pipe2 imm $78', 'imm'],
  [0x0DAC92,  51, 'pipe2 imm $7D', 'imm'],
  [0x0DAC92,  65, 'pipe2 imm $D8', 'imm'],
  [0x0DAC92,  73, 'pipe2 imm $DA', 'imm'],
  [0x0DAC92,  81, 'pipe2 imm $E6', 'imm'],
  [0x0DAC92,  89, 'pipe2 imm $E6', 'imm'],
  [0x0DAC92, 103, 'pipe2 imm $3F', 'imm'],
  [0x0DAD44,  28, 'pipe3 imm $3F', 'imm'],
  [0x0DAD44,  41, 'pipe3 imm $E6', 'imm'],
  [0x0DAD44,  49, 'pipe3 imm $E0', 'imm'],
  [0x0DAD44,  63, 'pipe3 imm $A0', 'imm'],
  [0x0DAD44,  71, 'pipe3 imm $A5', 'imm'],
  [0x0DADA3,  28, 'pipe4 imm $3F', 'imm'],
  [0x0DADA3,  41, 'pipe4 imm $E4', 'imm'],
  [0x0DADA3,  53, 'pipe4 imm $AF', 'imm'],
  [0x0DADEB,  26, 'pipe5 imm $3F', 'imm'],
  [0x0DADEB,  39, 'pipe5 imm $E6', 'imm'],
  [0x0DADEB,  47, 'pipe5 imm $E6', 'imm'],
  [0x0DADEB,  55, 'pipe5 imm $DB', 'imm'],
  [0x0DADEB,  63, 'pipe5 imm $DC', 'imm'],
  [0x0DADEB,  79, 'pipe5 imm $82', 'imm'],
  [0x0DADEB,  87, 'pipe5 imm $87', 'imm'],
  [0x0DADEB,  95, 'pipe5 imm $8C', 'imm'],
  [0x0DADEB, 103, 'pipe5 imm $91', 'imm'],
  [0x0DAE6D,  33, 'pipe6 imm $C6', 'imm'],
  [0x0DAE6D,  41, 'pipe6 imm $C7', 'imm'],
  [0x0DAE6D,  53, 'pipe6 imm $EE', 'imm'],
  [0x0DAE6D,  61, 'pipe6 imm $F0', 'imm'],
  [0x0DAE6D,  73, 'pipe6 imm $65', 'imm'],
  [0x0DAEFC,  31, 'pipe7 imm $65', 'imm'],
  [0x0DAEFC,  48, 'pipe7 imm $F0', 'imm'],
  [0x0DAEFC,  56, 'pipe7 imm $EF', 'imm'],
  [0x0DAEFC,  68, 'pipe7 imm $C8', 'imm'],
  [0x0DAEFC,  76, 'pipe7 imm $C9', 'imm'],
  [0x0DAF61,  32, 'pipe8 imm $C4', 'imm'],
  [0x0DAF61,  43, 'pipe8 imm $EC', 'imm'],
  [0x0DAF61,  54, 'pipe8 imm $65', 'imm'],
  [0x0DAFEA,  57, 'pipe9 imm $C5', 'imm'],
]

let bad = 0
for (const [base, o, label, kind] of refs) {
  const b = byte(base, o)
  const hex = b?.toString(16).padStart(2, '0').toUpperCase() ?? '??'
  let ok = true
  let note = ''
  if (kind === 'imm') {
    // A9 would mean we're pointing at the opcode, not the immediate
    if (b === 0xA9) { ok = false; note = '  ← POINTS AT OPCODE $A9' }
  } else if (kind === 'operand3') {
    // BF would mean we're pointing at the opcode
    if (b === 0xBF) { ok = false; note = '  ← POINTS AT OPCODE $BF' }
    // Real operand first byte is typically a data-table low byte ≠ 00
  } else if (kind === 'jsr2') {
    if (b === 0x20 || b === 0x4C) { ok = false; note = '  ← POINTS AT JSR/JMP OPCODE' }
  }
  if (!ok) bad++
  console.log(`${ok ? '✓' : '✗'} $${base.toString(16).toUpperCase()} +${o.toString().padStart(3)}  $${hex}  ${label}${note}`)
}
console.log(`\n${bad} off-by-one errors found out of ${refs.length} references`)
