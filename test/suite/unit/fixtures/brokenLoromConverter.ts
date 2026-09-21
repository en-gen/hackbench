/**
 * Shared test double reproducing the pre-fix `loromToOffset` exactly as it
 * shipped before the expanded-ROM addressing fix (see addressing.test.ts's
 * "teeth" suite). Used both as a mutation-test target there and, in
 * addressing.rom.test.ts, to compute a real pre-fix floor for the
 * Acceptance B level-count assertions instead of hardcoding magic numbers.
 */
import { LOROM_BANK_SIZE } from '../../../../src/rom/addressing'

export const brokenOldHiromShaped = (snesAddr: number): number | null => {
  const bank = (snesAddr >>> 16) & 0xff
  const addr = snesAddr & 0xffff
  const effectiveBank = bank & 0x7f
  if (effectiveBank <= 0x3f) {
    if (addr < 0x8000) return null
    return effectiveBank * LOROM_BANK_SIZE + (addr - 0x8000)
  }
  if (effectiveBank <= 0x6f) return (effectiveBank - 0x40) * LOROM_BANK_SIZE * 2 + addr
  return null
}
