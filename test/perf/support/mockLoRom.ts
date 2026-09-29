/**
 * A zero-filled buffer with only the LoROM map-mode byte set, shared by
 * every bench case that needs a RomFile but not real ROM content (docs/
 * testing.md's content gate). Not ROM content: every other byte is 0x00.
 */
import { RomFile } from '../../../src/rom/RomFile'

export function mockLoRom(size = 0x400000): RomFile {
  const buf = Buffer.alloc(size, 0x00)
  buf[0x7fd5] = 0x20
  return new RomFile('mock.smc', buf)
}
