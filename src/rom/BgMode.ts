/**
 * The BG mode a regular level runs in, read from the level loader's own code.
 *
 * The loader builds MainBGMode from header byte 3 as `(byte & $80) >> 4 | imm`
 * (SMWDisX bank_05.asm:592-597: AND #$80, four LSR, ORA #$01, STA MainBGMode),
 * so the mode is that ORA operand, never a table. The plane order the map view
 * stacks (BG1 high > BG2 high > BG1 low > BG2 low) holds only for mode 1.
 * Found by byte pattern inside bank 05 so a relocated-but-intact routine still
 * resolves; no match, several matches or a different mode is a refusal, never
 * a vanilla assumption. Path reachability (a hijacked caller) is not checked.
 */
import type { RomFile } from './RomFile'

export type BgModeResult = { ok: true; mode: number } | { ok: false; reason: string }

/** AND #$80, LSR x4, ORA #imm, STA dp: the operand sits at offset 6. */
const SIGNATURE = [0x29, 0x80, 0x4a, 0x4a, 0x4a, 0x4a, 0x09, -1, 0x85]
const OPERAND_AT = 7
const BANK_05 = 0x058000

export function readLevelBgMode(rom: RomFile): BgModeResult {
  const bank = rom.readAt(BANK_05, 0x8000)
  if (!bank) return { ok: false, reason: 'The ROM has no bank 05 to read the BG mode from' }
  const hits: number[] = []
  for (let i = 0; i + SIGNATURE.length <= bank.length; i++)
    if (SIGNATURE.every((b, j) => b === -1 || bank[i + j] === b)) hits.push(bank[i + OPERAND_AT]!)
  if (hits.length !== 1)
    return {
      ok: false,
      reason: `The level loader's BG mode code matches ${hits.length} times in bank 05, so the layer order is unknown`,
    }
  const mode = hits[0]! & 7
  return mode === 1
    ? { ok: true, mode }
    : {
        ok: false,
        reason: `This ROM runs levels in BG mode ${mode}; the map view draws mode 1 only`,
      }
}
