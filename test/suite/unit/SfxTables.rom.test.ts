/**
 * What the sound-effect tables read as on the six real ROMs.
 *
 * Pins the fact the feature rests on: both tables enumerate on the three
 * stock-engine ROMs and NEITHER does on the three AddmusicK ones. Reporting
 * the stock 42 and 52 for a ROM whose driver has been replaced would list
 * effects it does not have and play none of them, which is the failure this
 * whole module is shaped around.
 *
 * Also pins the two addresses the readers give up, because those are
 * recovered from operands rather than hardcoded, and a change that started
 * hardcoding them would otherwise look identical from the outside.
 *
 * Skips per file when test/roms/ is absent, which is always the case in CI.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../src/rom/RomFile'
import { readSfxTable, buildSfxSpc, SFX_PORTS, SfxPort } from '../../../src/rom/SfxTables'

const ROMS_DIR = resolve(__dirname, '../../roms')

interface PortShape {
  tableAram: number
  readerAram: number
  entries: number
  /** Ids whose phrase is a bare end marker, so they render silent. */
  emptyIds: string[]
}

/** Measured 2026-09-23 on this repo's six-ROM corpus, one machine. */
const STOCK: Record<SfxPort, PortShape> = {
  0: { tableAram: 0x5683, readerAram: 0x071f, entries: 42, emptyIds: ['$22', '$24'] },
  3: { tableAram: 0x561b, readerAram: 0x084e, entries: 52, emptyIds: [] },
}

const STOCK_ENGINE_ROMS = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Seven_Vanilla_Levels.sfc',
]

const ADDMUSICK_ROMS = ['Grand Poo World 2 1.1.sfc', 'GrandPooWorld_V1.2.sfc', 'Invictus 1.0.sfc']

describe('readSfxTable (requires test/roms/*.sfc)', () => {
  for (const file of STOCK_ENGINE_ROMS) {
    const path = resolve(ROMS_DIR, file)
    // skipIf per file: with the corpus absent these must still be
    // REGISTERED and reported skipped, not silently cease to exist.
    describe.skipIf(!existsSync(path))(file, () => {
      for (const port of SFX_PORTS) {
        const shape = STOCK[port]

        it(`reads ${shape.entries} entries on port ${port}`, () => {
          const result = readSfxTable(RomFile.load(path), port)

          expect(result.status).toBe('ok')
          if (result.status !== 'ok') return
          expect(result.table.entries).toHaveLength(shape.entries)
        })

        it(`recovers port ${port}'s table and reader from the reader's operands`, () => {
          const result = readSfxTable(RomFile.load(path), port)

          expect(result.status).toBe('ok')
          if (result.status !== 'ok') return
          expect(result.table.tableAram).toBe(shape.tableAram)
          expect(result.table.readerAram).toBe(shape.readerAram)
        })

        it(`flags port ${port}'s empty phrases and nothing else`, () => {
          const result = readSfxTable(RomFile.load(path), port)

          expect(result.status).toBe('ok')
          if (result.status !== 'ok') return
          const empty = result.table.entries.filter(e => e.empty).map(e => e.idHex)
          expect(empty).toEqual(shape.emptyIds)
        })
      }

      it('ids run from 1 with no gaps, which is what the game writes', () => {
        const result = readSfxTable(RomFile.load(path), 0)

        expect(result.status).toBe('ok')
        if (result.status !== 'ok') return
        expect(result.table.entries.map(e => e.id)).toEqual(
          Array.from({ length: STOCK[0].entries }, (_, i) => i + 1),
        )
      })

      it('builds a playable snapshot with the id on the port input register', () => {
        const rom = RomFile.load(path)
        const ARAM = 256
        const port0 = buildSfxSpc(rom, 0, 0x01)
        const port3 = buildSfxSpc(rom, 3, 0x01)

        expect(port0).not.toBeNull()
        expect(port3).not.toBeNull()
        expect(port0!.length).toBe(65920)
        expect(port0![ARAM + 0xf4]).toBe(0x01)
        expect(port3![ARAM + 0xf7]).toBe(0x01)
        // No BGM command: an effect plays over silence.
        expect(port0![ARAM + 0xf6]).toBe(0)
      })

      it('refuses an id past the end of the table', () => {
        // The engine does no bounds check, so an out-of-range id plays
        // whatever follows the table. The table bound is what keeps that
        // out of both the listing and the player.
        expect(buildSfxSpc(RomFile.load(path), 0, STOCK[0].entries + 1)).toBeNull()
      })
    })
  }

  for (const file of ADDMUSICK_ROMS) {
    const path = resolve(ROMS_DIR, file)
    describe.skipIf(!existsSync(path))(file, () => {
      for (const port of SFX_PORTS) {
        it(`reports port ${port} unavailable rather than the stock table`, () => {
          const result = readSfxTable(RomFile.load(path), port)

          expect(result.status).toBe('unavailable')
          if (result.status !== 'unavailable') return
          expect(result.reason).toMatch(/could not be verified|no sound effect table reader/i)
          // Never the stock answer, in any form.
          expect(result.reason).not.toContain('5683')
          expect(result.reason).not.toContain('561B')
        })
      }

      it('builds no snapshot', () => {
        expect(buildSfxSpc(RomFile.load(path), 0, 0x01)).toBeNull()
      })
    })
  }
})
