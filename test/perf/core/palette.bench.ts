import { describe } from 'vitest'
import { loadRomPalettes } from '../../../src/rom/PaletteLoader'
import { mockLoRom } from '../support/mockLoRom'
import { perfCase } from '../support/perfCase'

describe('core.palette.load', () => {
  const rom = mockLoRom()
  perfCase('core.palette.load.synthetic', () => loadRomPalettes(rom))
})
