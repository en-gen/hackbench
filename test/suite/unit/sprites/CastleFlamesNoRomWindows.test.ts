/**
 * #1061: the castle flames and rotating ring code, the shared stock-code gate and their test
 * support hold no 8-byte window of the vanilla ROM as text. Uses the probe's own scanner
 * (tools/scripts/lib/rom-windows.mjs). Needs the vanilla ROM; the planted case reads its
 * slice from that ROM at run time, so no ROM byte is committed here.
 * Evidence scope: text windows only; the assembled synthetic cart is SyntheticSpriteRomNoVanilla.test.ts.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
// @ts-expect-error plain ESM without types
import { commentMode, textHits, windowSet } from '../../../../tools/scripts/lib/rom-windows.mjs'
import { hasRom, romPath, VANILLA } from '../../support/corpus'

const REPO = join(__dirname, '../../../..')
const FILES = [
  'src/rom/SubmapFlagGate.ts',
  'src/rom/sprites/interp/CastleFlames.ts',
  'src/rom/sprites/interp/ClusterPath.ts',
  'src/rom/sprites/interp/RotatingRing.ts',
  'test/suite/support/clusterPathStandIn.ts',
  'test/suite/support/syntheticSpriteRom.ts',
  'test/suite/unit/sprites/CastleFlames.test.ts',
  'test/suite/unit/sprites/ClusterPath.test.ts',
  'test/suite/unit/sprites/ClusterPathGate.corpus.test.ts',
  'test/suite/unit/sprites/RotatingRing.test.ts',
  'test/suite/unit/sprites/CastleFlamesNoRomWindows.test.ts',
  'test/suite/unit/sprites/ClusterPathStandInNoVanilla.test.ts',
]

describe.skipIf(!hasRom(VANILLA))(
  'castle flames and ring sources and their tests hold no vanilla window',
  () => {
    let cached: Set<string> | undefined
    const windows = (): Set<string> =>
      (cached ??= windowSet(new Uint8Array(readFileSync(romPath(VANILLA)))))

    it.each(FILES)('%s: 0 windows', file => {
      const text = readFileSync(join(REPO, file), 'utf8')
      expect(textHits(text, windows(), 1, 8, commentMode(file))).toEqual([])
    })

    it('the scanner reports a planted vanilla slice as source text (it can fail)', () => {
      // 40 bytes from inside the ROM's code area, rendered as a TS array literal.
      const rom = new Uint8Array(readFileSync(romPath(VANILLA)))
      const slice = Array.from(rom.subarray(0x12000, 0x12028), b => `0x${b.toString(16)}`)
      const planted = `const x = [${slice.join(', ')}]\n`
      const hits = textHits(planted, windows(), 1, 8, 'js')
      expect(hits.length).toBeGreaterThan(0)
    })
  },
)
