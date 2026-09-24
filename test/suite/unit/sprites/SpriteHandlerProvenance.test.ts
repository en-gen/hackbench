/**
 * `describeHandlerProvenance` must be able to answer BOTH ways.
 *
 * On the shipped corpus it can only ever say "vanilla" for a draw handler:
 * measured in `docs/sprites/sprite-engine-divergence.md`, the MAIN pointer table is
 * byte-identical in all six ROM files in the corpus, and the only three
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
import { readFileSync } from 'fs'
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
import { CORPUS, VANILLA, freshRom, hasRoms, romPath } from '../../support/corpus'

/** Module-scope existence check only: every ROM read stays inside an `it()`
 *  so a missing corpus skips rather than failing collection. */
const romsPresent = hasRoms()

const DESCRIPTOR_IDS = SPRITE_DRAW_DESCRIPTORS.map(d => d.spriteId)

describe('describeHandlerProvenance', () => {
  it.skipIf(!romsPresent)('reports vanilla for every descriptor sprite on all ROMs', () => {
    for (let i = 0; i < CORPUS.length; i++) {
      const rom = freshRom(CORPUS[i])
      for (const id of DESCRIPTOR_IDS) {
        const p = describeHandlerProvenance(rom, id)
        expect(`${CORPUS[i]} $${id.toString(16)}: ${p.kind}`).toBe(
          `${CORPUS[i]} $${id.toString(16)}: vanilla`,
        )
      }
    }
  })

  it.skipIf(!romsPresent)('reports MAIN divergence when the draw pointer is repointed', () => {
    const id = 0x4d
    // In-memory copy: `writeAt` mutates this RomFile's buffer only, and
    // `save()` is never called, so the corpus is not touched.
    const patched = RomFile.fromBytes('patched', new Uint8Array(readFileSync(romPath(VANILLA))))
    patched.writeAt(SPRITE_MAIN_PTR_TABLE + id * 2, [0x34, 0x12])

    const p = describeHandlerProvenance(patched, id)
    expect(p.kind).toBe('diverged')
    if (p.kind !== 'diverged') throw new Error('unreachable')
    expect(p.divergences).toEqual([{ table: 'main', expected: 0xe2cf, found: 0x1234 }])
    expect(provenanceMessage(p)).toContain('custom handler, appearance unverified')
  })

  it.skipIf(!romsPresent)('reports INIT divergence separately from MAIN', () => {
    const id = 0x2c
    const patched = RomFile.fromBytes('patched', new Uint8Array(readFileSync(romPath(VANILLA))))
    patched.writeAt(SPRITE_INIT_PTR_TABLE + id * 2, [0x78, 0x56])
    const p = describeHandlerProvenance(patched, id)
    expect(p.kind).toBe('diverged')
    if (p.kind !== 'diverged') throw new Error('unreachable')
    expect(p.divergences.map(d => d.table)).toEqual(['init'])
    expect(p.divergences[0].found).toBe(0x5678)
  })

  it.skipIf(!romsPresent)('reports untraced for a sprite with no descriptor', () => {
    const rom = freshRom(VANILLA)
    // $15 Fish has a bespoke handler nobody has traced. Asserted rather than
    // assumed, so this goes red when $15 gains a descriptor instead of
    // quietly testing the wrong thing. $00 used to serve here and now has one.
    expect(SPRITE_DRAW_DESCRIPTORS.some(d => d.spriteId === 0x15)).toBe(false)
    expect(describeHandlerProvenance(rom, 0x15).kind).toBe('untraced')
  })

  it.skipIf(!romsPresent)('reports unreadable for an out-of-range sprite id', () => {
    const rom = freshRom(VANILLA)
    // Force a descriptor whose id is outside the 201-entry pointer tables.
    const fake = [{ ...SPRITE_DRAW_DESCRIPTORS[0], spriteId: 0xfe }]
    expect(describeHandlerProvenance(rom, 0xfe, fake).kind).toBe('unreadable')
  })
})
