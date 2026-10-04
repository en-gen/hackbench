/**
 * The BG mode a regular level runs in, read from the level loader's own code.
 *
 * The loader builds MainBGMode from header byte 3 as `(byte & $80) >> 4 | imm`
 * (SMWDisX bank_05.asm:592-597: AND #$80, four LSR, ORA #$01, STA MainBGMode),
 * so the mode is that ORA operand, never a table; bit 3 of the stored value is
 * layer 3 priority and is masked off. The plane order the map view stacks
 * (BG1 high > BG2 high > BG1 low > BG2 low) holds only for mode 1.
 *
 * Three readings must agree, each a byte pattern that matches exactly once:
 * the ORA site above, the call into it from LoadLevel (`JSR` at bank_05.asm:428,
 * the target must lead to the site) and the IRQ's copy of MainBGMode to
 * HW_BGMODE (bank_00.asm:464-465: LDA dp, STA $2105; dp is the STA operand
 * of the ORA site). A patch that hijacks the call or the copy leaves the
 * ORA site pristine, which is why the site alone is not enough.
 *
 * Hack-fragility point: Lunar Magic hooks LoadLevel around the `ORA / STA` at
 * $058568 on all 4 corpus hacks (and the boss-mode check after the call), and
 * code at the hook could rewrite MainBGMode afterwards. Nothing here follows a
 * hook, so a hooked loader reads as unverified, never as mode 1.
 */
import { findPattern, WILD, type BytePattern } from './BytePattern'
import { loromFromOffset } from './addressing'
import type { RomFile } from './RomFile'

export type BgModeResult = { ok: true; mode: number } | { ok: false; reason: string }

/** AND #$80, LSR x4, ORA #imm, STA dp. */
const SET: BytePattern = [0x29, 0x80, 0x4a, 0x4a, 0x4a, 0x4a, 0x09, WILD, 0x85, WILD]
const OPERAND_AT = SET.indexOf(WILD)
const DP_AT = SET.length - 1
/** JSR header, JSR next, then LoadAgain's LDA LevelModeSetting / CMP / BEQ. */
const CALL: BytePattern = [0x20, WILD, WILD, 0x20, WILD, WILD, 0xad, 0x25, 0x19, 0xc9, WILD, 0xf0, WILD] // prettier-ignore
/** How far past the routine's entry the ORA site may sit: 0x85 on a stock ROM (bank_05.asm:523-597), with slack. */
const ROUTINE_SPAN = 0xc0

/** The pattern's one match, or why there is not one. */
function once(rom: RomFile, p: BytePattern, what: string): number | string {
  const hits = findPattern(rom, p, 2)
  return hits.length === 1 ? hits[0]! : `${what} ${hits.length === 0 ? 'is not found' : 'is found more than once'}` // prettier-ignore
}

export function readLevelBgMode(rom: RomFile): BgModeResult {
  const no = (why: string): BgModeResult => ({
    ok: false,
    reason: `The level loader's BG mode could not be verified: ${why}, so the layer order is unknown`,
  })
  const set = once(rom, SET, 'the MainBGMode write')
  if (typeof set === 'string') return no(set)
  const call = once(rom, CALL, "LoadLevel's call into the header routine")
  if (typeof call === 'string') return no(call)
  const code = rom.readAtFileOffset(set, SET.length)!
  const jsr = rom.readAtFileOffset(call, 3)!
  const setAddr = loromFromOffset(set)
  const callAddr = loromFromOffset(call)
  if (setAddr === null || callAddr === null) return no('a site is outside the ROM map')
  const entry = (callAddr & 0xff0000) | (jsr[1]! | (jsr[2]! << 8))
  if (setAddr >> 16 !== entry >> 16 || setAddr < entry || setAddr >= entry + ROUTINE_SPAN)
    return no('the routine LoadLevel calls does not hold the MainBGMode write')
  const copy = once(rom, [0xa5, code[DP_AT]!, 0x8d, 0x05, 0x21], 'the IRQ copy of MainBGMode')
  if (typeof copy === 'string') return no(copy)
  const mode = code[OPERAND_AT]! & 7
  return mode === 1
    ? { ok: true, mode }
    : { ok: false, reason: `This ROM runs levels in BG mode ${mode}; the layer order drawn is for mode 1` } // prettier-ignore
}
