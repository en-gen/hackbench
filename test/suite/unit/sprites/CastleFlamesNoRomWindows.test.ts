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
import { RomFile } from '../../../../src/rom/RomFile'
import { FLAME_PATH, pathMismatches } from '../../../../src/rom/sprites/interp/CastleFlames'
import { ringGate } from '../../../../src/rom/sprites/interp/RotatingRing'
import { STANDIN } from '../../support/clusterPathStandIn'
import { hasRom, romPath, VANILLA } from '../../support/corpus'

const REPO = join(__dirname, '../../../..')
/** SubmapFlagGate.ts: 3 stock-code literals (21 windows) still wait for #1109 (they feed 15 readers and the overworld synthetic builders). Pinned so the count cannot grow and a fix must delete this line. */
const DEFERRED = { file: 'src/rom/SubmapFlagGate.ts', windows: 21 }
const FILES = [
  'src/rom/sprites/interp/CastleFlames.ts',
  'src/rom/sprites/interp/RotatingRing.ts',
  'test/suite/unit/sprites/CastleFlames.test.ts',
  'test/suite/support/syntheticSpriteRom.ts',
]

describe.skipIf(!hasRom(VANILLA))('castle flames and ring sources hold no vanilla window', () => {
  let cached: Set<string> | undefined
  const windows = (): Set<string> =>
    (cached ??= windowSet(new Uint8Array(readFileSync(romPath(VANILLA)))))

  it.each(FILES)('%s: 0 windows', file => {
    const text = readFileSync(join(REPO, file), 'utf8')
    expect(textHits(text, windows(), 1, 8, commentMode(file))).toEqual([])
  })

  it('SubmapFlagGate.ts: the deferred literals are exactly the known ones (#1109)', () => {
    const text = readFileSync(join(REPO, DEFERRED.file), 'utf8')
    const hits = textHits(text, windows(), 1, 8, commentMode(DEFERRED.file))
    expect(hits.reduce((n: number, h: { windows: number }) => n + h.windows, 0)).toBe(
      DEFERRED.windows,
    )
  })

  it('the scanner reports a planted vanilla slice as source text (it can fail)', () => {
    // 40 bytes from inside the ROM's code area, rendered as a TS array literal.
    const rom = new Uint8Array(readFileSync(romPath(VANILLA)))
    const slice = Array.from(rom.subarray(0x12000, 0x12028), b => `0x${b.toString(16)}`)
    const planted = `const x = [${slice.join(', ')}]\n`
    const hits = textHits(planted, windows(), 1, 8, 'js')
    expect(hits.length).toBeGreaterThan(0)
  })

  describe('the run-based path gate on the vanilla ROM', () => {
    const bytes = () => new Uint8Array(readFileSync(romPath(VANILLA)))
    const off = (snes: number) => ((snes >> 16) << 15) | (snes & 0x7fff)
    const withByte = (snes: number, xor: number) => {
      const b = bytes()
      b[off(snes) + (b.length % 1024 === 512 ? 512 : 0)]! ^= xor
      return RomFile.fromBytes('v.sfc', b)
    }
    const vanillaRom = () => RomFile.fromBytes('v.sfc', bytes())
    it('accepts vanilla for the flames and the ring', () => {
      expect(pathMismatches(vanillaRom(), FLAME_PATH)).toEqual([])
      expect(ringGate(vanillaRom()).filter(w => /route|branch|loop/.test(w))).toEqual([])
    })
    it('a one-byte change in the type 5 / type 4 dispatch word refuses by name', () => {
      expect(pathMismatches(withByte(STANDIN.typeTable + 10, 1), FLAME_PATH)).toEqual([
        'the cluster loop for type 5',
      ])
      expect(ringGate(withByte(STANDIN.typeTable + 8, 1))).toContain('the cluster loop for type 4')
    })
  })
})
