/**
 * The arena against real cartridges.
 *
 * the corpus is gitignored, so CI never runs this; the arena's gates and
 * refusals are proven synthetically in GfxArena.synthetic.test.ts. What only
 * a real cart can show is that the packing actually reproduces itself and
 * that the numbers in docs/gfx-arena-budget.md still hold.
 *
 * Gated per cart with `describe.skipIf` so the cases SKIP rather than vanish
 * when the corpus is absent. Reports no ROM bytes, only counts.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  GFX_FILE_COUNT,
  HOOK_FINGERPRINTS,
  LEVEL_GFX_CALLERS,
  computeHookFingerprint,
  planRegions,
  readGfxFileTable,
} from '../../../src/rom/GfxArena'
import { GfxTable, planGfxSave, readTilesPerFile } from '../../../src/rom/GfxTable'
import { COPIER_HEADER_SIZE } from '../../../src/rom/addressing'
import { hasRom, romPath } from '../support/corpus'

/** Measured across this corpus on one machine. `slack` is what the packed
 *  regions have spare; see docs/gfx-arena-budget.md. */
const CARTS = [
  { name: 'Super Mario World (USA).vanilla.sfc', regions: 1, used: 107284, slack: 755 },
  { name: 'Super Mario World (USA).magic.sfc', regions: 1, used: 107284, slack: 755 },
  { name: 'Seven_Vanilla_Levels.sfc', regions: 1, used: 107284, slack: 755 },
  { name: 'GrandPooWorld_V1.2.sfc', regions: 4, used: 115981, slack: 0 },
  { name: 'Grand Poo World 2 1.1.sfc', regions: 4, used: 115965, slack: 0 },
]

/** The 4 corpus ROMs whose primary level-GFX call is the Lunar Magic ExGFX
 *  hook rather than PrepareGraphicsFile directly. Invictus is here too,
 *  even though it fails the separate decompressor check, since the hook
 *  fingerprint is unrelated to that gate. */
const HOOKED = [
  'GrandPooWorld_V1.2.sfc',
  'Grand Poo World 2 1.1.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
]

for (const name of HOOKED) {
  describe.skipIf(!hasRom(name))(`${name}: ExGFX hook`, () => {
    it('fingerprints to a known hook build', () => {
      const rom = RomFile.load(romPath(name))
      const jsl = rom.readAt(LEVEL_GFX_CALLERS[0]!, 4)!
      const target = (jsl[1]! | (jsl[2]! << 8) | (jsl[3]! << 16)) & 0x7fffff
      expect(HOOK_FINGERPRINTS).toContain(computeHookFingerprint(rom, target))
    })
  })
}

for (const cart of CARTS) {
  const path = romPath(cart.name)
  describe.skipIf(!hasRom(cart.name))(`${cart.name}: arena`, () => {
    it('measures the packing the documented figures were taken from', () => {
      const rom = RomFile.load(path)
      const regions = planRegions(rom, readGfxFileTable(rom))
      const used = regions.reduce((n, r) => n + r.used, 0)
      const capacity = regions.reduce((n, r) => n + r.capacity, 0)
      expect({ regions: regions.length, used, slack: capacity - used }).toEqual({
        regions: cart.regions,
        used: cart.used,
        slack: cart.slack,
      })
    })

    it('reads 128 tiles per file out of the upload loop', () => {
      expect(readTilesPerFile(RomFile.load(path))).toBe(128)
    })

    it('re-encodes an untouched cartridge to exactly its own size', () => {
      // The property the whole structure-preserving approach rests on. A
      // from-scratch encoder came to 117,834 here against vanilla's 107,284.
      const rom = RomFile.load(path)
      const r = planGfxSave(rom, GfxTable.load(rom))
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      expect(r.plan.regions.reduce((n, g) => n + g.needed, 0)).toBe(cart.used)
    })

    it('painting a whole tile flat RECLAIMS bytes rather than costing them', () => {
      // The spike guessed this and could not measure it without a real
      // encoder. It is also the only edit that fits on a zero-slack cart.
      const rom = RomFile.load(path)
      const table = GfxTable.load(rom)
      const file = table.files.findIndex(f => f.bpp !== null && f.tileCount > 0)
      expect(file).toBeGreaterThanOrEqual(0)
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          table.setPixel({ kind: 'gfxPixel', file, tile: 0, x, y, value: 0 })
        }
      }
      const r = planGfxSave(rom, table)
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return
      expect(r.plan.regions.reduce((n, g) => n + g.needed, 0)).toBeLessThan(cart.used)
    })

    it('a saved pixel reads back off the repacked cartridge', () => {
      const rom = RomFile.load(path)
      const table = GfxTable.load(rom)
      const file = table.files.findIndex(f => f.bpp !== null && f.tileCount > 4)
      // Flat first, so the edit pays for itself on a zero-slack cartridge:
      // this case is about the round trip, not about the budget.
      for (let y = 0; y < 8; y++) {
        for (let x = 0; x < 8; x++) {
          table.setPixel({ kind: 'gfxPixel', file, tile: 1, x, y, value: 1 })
        }
      }
      const r = planGfxSave(rom, table)
      expect(r.status).toBe('ok')
      if (r.status !== 'ok') return

      const after = Buffer.from(rom.buffer)
      const base = rom.hasHeader ? COPIER_HEADER_SIZE : 0
      for (const w of r.plan.writes) after.set(w.bytes, base + w.offset)
      const reloaded = GfxTable.load(new RomFile('repacked.sfc', after))

      expect(reloaded.tile(file, 1)!.every(v => v === 1)).toBe(true)
      // And every other file still resolves: a pointer rewrite that dropped
      // one leaves the cartridge booting to garbage graphics.
      for (let i = 0; i < GFX_FILE_COUNT; i++) {
        expect(reloaded.files[i]!.template.length, `GFX ${i}`).toBeGreaterThan(0)
        expect(reloaded.files[i]!.bytes.length, `GFX ${i} output`).toBe(
          table.files[i]!.bytes.length,
        )
      }
    })
  })
}
