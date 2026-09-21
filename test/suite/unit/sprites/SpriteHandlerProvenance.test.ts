/**
 * `describeHandlerProvenance` must be able to answer BOTH ways.
 *
 * On the shipped corpus it can only ever say "vanilla" for a draw handler:
 * measured in `docs/sprite-engine-divergence.md`, the MAIN pointer table is
 * byte-identical in all six ROM files in `test/roms/`, and the only three
 * INIT repoints are at $52, $53 and $9B, none of which is a descriptor
 * sprite. A query that has never been observed returning its other answer is
 * an unproven oracle, so the divergence branch is driven by patching a
 * pointer in an in-memory copy of the cart rather than by hoping a hack
 * happens to exercise it.
 *
 * Evidence scope: static reads of 6 ROM files plus one synthetic patch. No
 * emulator was run.
 */

import { describe, it, expect } from 'vitest'
import { existsSync, readFileSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../../src/rom/RomFile'
import {
  SPRITE_DRAW_DESCRIPTORS,
  SPRITE_MAIN_PTR_TABLE,
  SPRITE_INIT_PTR_TABLE,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawDescriptor'
import {
  describeHandlerProvenance,
  provenanceMessage,
} from '../../../../src/rom/model/sprites/generic/SpriteHandlerProvenance'

const ROM_DIR = resolve(__dirname, '../../../roms')
const ROM_FILES = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
] as const
const romPaths = ROM_FILES.map(f => resolve(ROM_DIR, f))
/** Module-scope existence check only: every ROM read stays inside an `it()`
 *  so a missing `test/roms/` skips rather than failing collection. */
const romsPresent = romPaths.every(existsSync)

const DESCRIPTOR_IDS = SPRITE_DRAW_DESCRIPTORS.map(d => d.spriteId)

describe('describeHandlerProvenance', () => {
  it.skipIf(!romsPresent)('reports vanilla for every descriptor sprite on all ROMs', () => {
    for (let i = 0; i < ROM_FILES.length; i++) {
      const rom = RomFile.load(romPaths[i])
      for (const id of DESCRIPTOR_IDS) {
        const p = describeHandlerProvenance(rom, id)
        expect(`${ROM_FILES[i]} $${id.toString(16)}: ${p.kind}`).toBe(
          `${ROM_FILES[i]} $${id.toString(16)}: vanilla`,
        )
      }
    }
  })

  it.skipIf(!romsPresent)('reports MAIN divergence when the draw pointer is repointed', () => {
    const id = 0x4d
    // In-memory copy: `writeAt` mutates this RomFile's buffer only, and
    // `save()` is never called, so `test/roms/` is not touched.
    const patched = RomFile.fromBytes('patched', new Uint8Array(readFileSync(romPaths[0])))
    patched.writeAt(SPRITE_MAIN_PTR_TABLE + id * 2, [0x34, 0x12])

    const p = describeHandlerProvenance(patched, id)
    expect(p.kind).toBe('diverged')
    if (p.kind !== 'diverged') throw new Error('unreachable')
    expect(p.divergences).toEqual([{ table: 'main', expected: 0xe2cf, found: 0x1234 }])
    expect(provenanceMessage(p)).toContain('custom handler, appearance unverified')
  })

  it.skipIf(!romsPresent)('reports INIT divergence separately from MAIN', () => {
    const id = 0x2c
    const patched = RomFile.fromBytes('patched', new Uint8Array(readFileSync(romPaths[0])))
    patched.writeAt(SPRITE_INIT_PTR_TABLE + id * 2, [0x78, 0x56])
    const p = describeHandlerProvenance(patched, id)
    expect(p.kind).toBe('diverged')
    if (p.kind !== 'diverged') throw new Error('unreachable')
    expect(p.divergences.map(d => d.table)).toEqual(['init'])
    expect(p.divergences[0].found).toBe(0x5678)
  })

  it.skipIf(!romsPresent)('reports untraced for a sprite with no descriptor', () => {
    const rom = RomFile.load(romPaths[0])
    // $15 Fish has a bespoke handler nobody has traced. Asserted rather than
    // assumed, so this goes red when $15 gains a descriptor instead of
    // quietly testing the wrong thing. $00 used to serve here and now has one.
    expect(SPRITE_DRAW_DESCRIPTORS.some(d => d.spriteId === 0x15)).toBe(false)
    expect(describeHandlerProvenance(rom, 0x15).kind).toBe('untraced')
  })

  it.skipIf(!romsPresent)('reports unreadable for an out-of-range sprite id', () => {
    const rom = RomFile.load(romPaths[0])
    // Force a descriptor whose id is outside the 201-entry pointer tables.
    const fake = [{ ...SPRITE_DRAW_DESCRIPTORS[0], spriteId: 0xfe }]
    expect(describeHandlerProvenance(rom, 0xfe, fake).kind).toBe('unreadable')
  })
})
