/**
 * isOverworldLevel is a hardcoded vanilla range, not a law.
 *
 * The slot a launch tile starts is read from the overworld Layer-1 Map16
 * stream plus the submap flag (deriveOverworldEntrances, which walks the ROM
 * the way CODE_04D7F2 does). Nothing constrains that slot to $000-$024 /
 * $101-$13B; a hack can place a map at any of the 512 slots and point a launch
 * tile at it. isOverworldLevel encodes what vanilla happens to use.
 *
 * This measures the divergence across the corpus. Where it is non-zero,
 * LevelTree.ts:41 absorbs a real level as a sub area and MapTree.ts:104 drops
 * it as a root, so the level never appears and its exits are misattributed.
 */
import { describe, it, expect } from 'vitest'
import * as path from 'path'
import { SmwRom, isOverworldLevel } from '../../../src/rom/SmwRom'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { hasRom, romPath } from '../support/corpus'

const NAMES = [
  'Super Mario World (USA).vanilla.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
]

const hex = (n: number) => '$' + n.toString(16).toUpperCase().padStart(3, '0')

describe.skipIf(!NAMES.some(n => hasRom(n)))(
  'isOverworldLevel vs the ROM-derived entrances',
  () => {
    it('reports where the hardcoded range disagrees with the cart', () => {
      const report: string[] = []
      const present = NAMES.filter(n => hasRom(n)).map(romPath)
      for (const file of present) {
        const rom = SmwRom.open(file)
        const index = deriveOverworldEntrances(rom)
        const name = path.basename(file)

        if (!index.overworldReadable) {
          report.push(`${name}: overworld not readable, derivation declines (fail closed)`)
          continue
        }

        // Entry maps the ROM says exist but the range predicate rejects.
        const missed = index.entryMaps.filter(s => !isOverworldLevel(s, index.roots))
        // Slots the predicate accepts that no launch tile actually starts.
        const entrySet = new Set(index.entryMaps)
        const phantom: number[] = []
        for (let s = 0; s <= 0x1ff; s++)
          if (isOverworldLevel(s, index.roots) && !entrySet.has(s)) phantom.push(s)

        report.push(
          `${name}\n` +
            `  launch tiles ${index.entrances.length}, entry maps ${index.entryMaps.length}\n` +
            `  entry maps the range REJECTS (level lost) : ${missed.length}` +
            `${missed.length ? '  ' + missed.map(hex).join(' ') : ''}\n` +
            `  range accepts but no launch tile starts   : ${phantom.length}`,
        )
      }
      console.log(report.join('\n'))
      expect(present.length).toBeGreaterThan(0)
    })
  },
)
