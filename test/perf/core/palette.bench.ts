import { describe, it } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { loadRomPalettes } from '../../../src/rom/PaletteLoader'
import { perfCase } from '../support/perfCase'

// Zero-filled buffer with a valid LoROM map-mode byte, per
// PaletteLoader.synthetic.test.ts's make4MbRom(). Not ROM content: every
// byte is 0x00 except the mode byte RomFile requires to pick LoROM addressing.
function make4MbRom(): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  return new RomFile('mock.smc', buf)
}

describe('core.palette.load', () => {
  it('synthetic', async () => {
    const rom = make4MbRom()
    await perfCase('core.palette.load.synthetic', 'ms', 'lower', () => {
      loadRomPalettes(rom)
    })
  })
})
