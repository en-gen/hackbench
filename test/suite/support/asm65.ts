/**
 * Opcode names for hand-written 65816 fixtures. A synthetic cart spells its stand-in routines as
 * `OP.LDA_IMM, 7, OP.STA_ABS, ...` so a fixture reads as the minimal instruction sequence it is, and
 * never as a pasted run of game bytes (test/suite/gates/noCopiedGameCode.test.ts).
 */
export const OP = {
  PHP: 0x08,
  TSB_DP: 0x04,
  ASL_A: 0x0a,
  CLC: 0x18,
  JSR: 0x20,
  PLP: 0x28,
  DEC_A: 0x3a,
  ADC_DP: 0x65,
  RTL: 0x6b,
  ADC_ABS: 0x6d,
  STA_DP: 0x85,
  STA_ABS: 0x8d,
  STA_LONG: 0x8f,
  STA_LONGX: 0x9f,
  STZ_DP: 0x64,
  LDX_IMM: 0xa2,
  LDA_IMM: 0xa9,
  LDA_DP: 0xa5,
  LDA_ABS: 0xad,
  LDA_ABSX: 0xbd,
  TAY: 0xa8,
  SEC: 0x38,
  LSR_A: 0x4a,
  SBC_DP: 0xe5,
  LDA_DPX: 0xb5,
  STA_ABSY: 0x99,
  STA_ABSX: 0x9d,
  LDY_ABS: 0xac,
  STY_DP: 0x84,
  STX_ABS: 0x8e,
  INC_DPX: 0xf6,
  INC_A: 0x1a,
  TAX: 0xaa,
  PLB: 0xab,
  REP: 0xc2,
  SEP: 0xe2,
  BEQ: 0xf0,
  BMI: 0x30,
  RTS: 0x60,
  COP: 0x02,
  NOP: 0xea,
} as const

/** A 16-bit operand as two little-endian bytes. */
export const word = (v: number): number[] => [v & 0xff, (v >> 8) & 0xff]
/** A 24-bit address as three little-endian bytes. */
export const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]
