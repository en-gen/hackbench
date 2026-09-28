import { describe, it } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { hasRom, romPath, VANILLA } from '../../suite/support/corpus'
import { perfCase } from '../support/perfCase'

// The only corpus-backed case in the v1 set (design section 2): gated with
// describe.skipIf, never by looping over a corpus listing, so CI (no ROM)
// still registers this case as skipped rather than silently dropping it.
describe.skipIf(!hasRom(VANILLA))('core.rom.load.corpus-vanilla', () => {
  it('corpus-vanilla', async () => {
    const path = romPath(VANILLA)
    await perfCase('core.rom.load.corpus-vanilla', 'ms', 'lower', () => {
      RomFile.load(path)
    })
  })
})
