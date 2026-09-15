/**
 * Shared test double reproducing the pre-fix `loromToOffset` exactly as it
 * shipped before the expanded-ROM addressing fix (see addressing.test.ts's
 * "teeth" suite). Used both as a mutation-test target there and, in
 * addressing.rom.test.ts, to compute a real pre-fix floor for the
 * Acceptance B level-count assertions instead of hardcoding magic numbers.
 */
import { LOROM_BANK_SIZE } from '../../../../src/rom/addressing'

export const brokenOldHiromShaped = (snesAddr: number): number | null => {
  const bank = (snesAddr >>> 16) & 0xFF
  const addr = snesAddr & 0xFFFF
  const effectiveBank = bank & 0x7F
  if (effectiveBank <= 0x3F) {
    if (addr < 0x8000) return null
    return effectiveBank * LOROM_BANK_SIZE + (addr - 0x8000)
  }
  if (effectiveBank <= 0x6F) return (effectiveBank - 0x40) * LOROM_BANK_SIZE * 2 + addr
  return null
}
