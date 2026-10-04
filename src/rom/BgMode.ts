/**
 * The BG mode a regular level runs in, read from the level loader's own code:
 * the ORA operand in `AND #$80 / LSR x4 / ORA #imm / STA MainBGMode`
 * (SMWDisX bank_05.asm:591-597), which is not a table. The plane order the map
 * view stacks holds only for mode 1. Three byte patterns must each resolve
 * exactly once and agree: that write, the call into its routine with the code
 * after it intact, and the IRQ's copy of MainBGMode to $2105 (bank_00.asm:464-465).
 *
 * Fragility: Lunar Magic hooks LoadLevel around the write on the corpus hacks,
 * and a hooked loader reads as unverified, never as mode 1. Derivation and
 * corpus measurements: docs/rom/bg-mode.md.
 */
import { findPattern, matchesAt, WILD, type BytePattern } from './BytePattern'
import { loromFromOffset } from './addressing'
import type { RomFile } from './RomFile'

export type BgModeResult = { ok: true; mode: number } | { ok: false; reason: string }

/** AND #$80, LSR x4, ORA #imm, STA dp. */
const SET: BytePattern = [0x29, 0x80, 0x4a, 0x4a, 0x4a, 0x4a, 0x09, WILD, 0x85, WILD]
const OPERAND_AT = SET.indexOf(WILD)
const DP_AT = SET.length - 1
/** JSR header, JSR next: LoadLevel's two calls (bank_05.asm:428-429). */
const CALLS: BytePattern = [0x20, WILD, WILD, 0x20, WILD, WILD]
/** LoadAgain's LDA LevelModeSetting / CMP / BEQ (bank_05.asm:431-433), which follows the calls. */
const TAIL: BytePattern = [0xad, 0x25, 0x19, 0xc9, WILD, 0xf0, WILD]
/** How far past the routine's entry the write may sit: 0x85 on a stock ROM, with slack. */
export const ROUTINE_SPAN = 0xc0

const no = (why: string): BgModeResult => ({
  ok: false,
  reason: `The level loader's BG mode could not be verified: ${why}, so the layer order is unknown`,
})

export function readLevelBgMode(rom: RomFile): BgModeResult {
  const sets = findPattern(rom, SET, 2)
  if (sets.length !== 1) return no(`the MainBGMode write ${sets.length ? 'is found more than once' : 'is not found'}`) // prettier-ignore
  const code = rom.readAtFileOffset(sets[0]!, SET.length)!
  const setAddr = loromFromOffset(sets[0]!)
  if (setAddr === null) return no('the MainBGMode write is outside the ROM map')
  // The one `JSR entry` pair whose entry leads to the write: LoadLevel's call into the header routine.
  const calls = findPattern(rom, CALLS).filter(at => {
    const addr = loromFromOffset(at)
    const jsr = rom.readAtFileOffset(at, 3)!
    if (addr === null || addr >> 16 !== setAddr >> 16) return false
    const entry = (addr & 0xff0000) | (jsr[1]! | (jsr[2]! << 8))
    return setAddr >= entry && setAddr < entry + ROUTINE_SPAN
  })
  if (calls.length !== 1) {
    return no(`LoadLevel's call into the header routine ${calls.length ? 'is found more than once' : 'is not found'}`) // prettier-ignore
  }
  if (!matchesAt(rom, calls[0]! + CALLS.length, TAIL)) {
    return no("the code after LoadLevel's call is replaced (a hook), and could rewrite MainBGMode")
  }
  const copy = findPattern(rom, [0xa5, code[DP_AT]!, 0x8d, 0x05, 0x21], 2)
  if (copy.length !== 1) return no(`the IRQ copy of MainBGMode ${copy.length ? 'is found more than once' : 'is not found'}`) // prettier-ignore
  const mode = code[OPERAND_AT]! & 7
  return mode === 1
    ? { ok: true, mode }
    : { ok: false, reason: `This ROM runs levels in BG mode ${mode}; the layer order drawn is for mode 1` } // prettier-ignore
}
