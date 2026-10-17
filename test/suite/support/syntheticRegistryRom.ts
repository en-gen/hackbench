/**
 * Synthetic 512 KiB ROM for the working-copy registry tests (#975). A period-256
 * ramp, so it shares no 8-byte run with the vanilla ROM; the title is spelled
 * with hyphens for the same reason. SyntheticRomNoVanilla975.test.ts scans
 * exactly these bytes.
 */
import { loromToOffset } from '../../../src/rom/addressing'

/** The word the registry tests edit. SMWDisX bank_00.asm:11257. */
export const MARIO_RED_ADDR = 0x00b2ce

export function rampRom(): Uint8Array {
  const rom = new Uint8Array(0x80000)
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 31) & 0xff
  return rom
}

export function fakeRom(): Uint8Array {
  const rom = rampRom()
  rom.set(Buffer.from('SUPER-MARIO-WORLD ', 'ascii'), 0x7fc0)
  const offset = loromToOffset(MARIO_RED_ADDR, rom.length, false) as number
  rom[offset] = 0x1f
  rom[offset + 1] = 0x39 // $391F
  return rom
}
