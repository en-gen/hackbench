import type { RomFile } from '../../../src/rom/RomFile'

/** LoadLevel's mode-compare chains (SMWDisX bank_05.asm:431-437 and 444-457); the second sits 28 bytes on. */
export const SKIP_CHAIN_AT = 0x0583b8
export const SKIP_CHAIN_B_AT = SKIP_CHAIN_AT + 28
const TARGET = SKIP_CHAIN_AT + 0x70 // stands for LoadLevelDone; every BEQ must reach the same place

const chain = (at: number, modes: number[], leadingBeq: boolean): number[] => {
  const out: number[] = [0xad, 0x25, 0x19] // LDA.W LevelModeSetting
  const beq = () => out.push(0xf0, (TARGET - (at + out.length + 2)) & 0xff)
  if (leadingBeq) beq()
  for (const m of modes) {
    out.push(0xc9, m)
    beq()
  }
  return out
}

/**
 * Synthetic skip chains: ten mode numbers in two runs, assembled at runtime from the ISA
 * (LDA.W, CMP #imm, BEQ rel8; the RAM address is the SMWDisX label) with an invented branch
 * target. No ROM run is reproduced: no byte sequence here is read from or matches the cartridge.
 */
export function writeStockSkipChain(rom: RomFile): void {
  rom.writeAt(SKIP_CHAIN_AT, chain(SKIP_CHAIN_AT, [0x09, 0x0b, 0x10], false))
  rom.writeAt(SKIP_CHAIN_B_AT, chain(SKIP_CHAIN_B_AT, [0x0a, 0x0c, 0x0d, 0x0e, 0x11, 0x1e], true))
}
