import type { RomFile } from '../../../src/rom/RomFile'

/** The bytes of banks 0 to `banks - 1` of a LoROM cart (the 32 KB half of each), in order. */
export function cartBytes(rom: RomFile, banks = 8): number[] {
  const out: number[] = []
  for (let bank = 0; bank < banks; bank++)
    for (const b of rom.readAt((bank << 16) | 0x8000, 0x8000)) out.push(b)
  return out
}
