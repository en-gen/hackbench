/**
 * #637: the game's LoadLevel loads no Layer 2 objects in ten level modes
 * (SMWDisX bank_05.asm:431-457), unless the level-load site is hijacked, so `buildL2` must not expand an L2 object
 * stream there. Synthetic ROM; the stream reader is mocked so the test can
 * see whether it was asked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import * as L2LoaderReal from '../../../../src/rom/L2Loader'
import type * as L2LoaderMod from '../../../../src/rom/L2Loader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { buildL2 } from '../../../../src/rom/model/L2Factory'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'

vi.mock('../../../../src/rom/L2Loader', async importOriginal => {
  const real = await importOriginal<typeof L2LoaderMod>()
  return { ...real, loadL2Objects: vi.fn(real.loadL2Objects) }
})
afterEach(() => vi.mocked(L2LoaderReal.loadL2Objects).mockReset())

const LEVEL = 5
const SKIPPED = [0x00, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x10, 0x11, 0x1e]
const SITE = 0x05803b // CMP #$FF at the L2 preset check (bank_05.asm:33); Lunar Magic JMLs over it

describe('buildL2 in level modes without a Layer 2 pass (synthetic)', () => {
  const rom = new RomFile('l2.sfc', Buffer.alloc(0x80000, 0))
  rom.writeAt(0x05e600 + LEVEL * 3, [0x00, 0x90, 0x0c]) // an object-stream L2 pointer, not a $FF preset

  const l2At = (mode: number) => {
    const header = parseLevelHeader(Uint8Array.from([0, mode, 0, 0, 0]))
    return buildL2(rom, LEVEL, header, 1, false, new Map(), new Map(), new Map(), null, 0, new Array<number>(32).fill(0)) // prettier-ignore
  }

  it('builds no L2 in exactly the ten skipped modes on a stock site, sweeping all 32', () => {
    rom.writeAt(SITE, [0xc9])
    for (let mode = 0; mode < 32; mode++) {
      vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid: [[1]] })
      const l2 = l2At(mode)
      const read = vi.mocked(L2LoaderReal.loadL2Objects).mock.calls.length > 0
      expect([l2 === null, read], `mode ${mode}`).toEqual(SKIPPED.includes(mode) ? [true, false] : [false, true]) // prettier-ignore
      vi.mocked(L2LoaderReal.loadL2Objects).mockReset()
    }
  })

  it('keeps building the L2 in all ten modes when the site is hijacked', () => {
    rom.writeAt(SITE, [0x5c, 0x10, 0xf5]) // JML $0EF510 prefix
    for (const mode of SKIPPED) {
      vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid: [[1]] })
      expect(l2At(mode), `mode ${mode}`).not.toBeNull()
      vi.mocked(L2LoaderReal.loadL2Objects).mockReset()
    }
    rom.writeAt(SITE, [0xc9])
  })
})

// Proves the gate is ON for the stock ROM (corpus only; the synthetic cases above run in CI).
describe.skipIf(!hasRom(VANILLA))('levelModeLoadsL2Objects on the vanilla ROM', () => {
  it('refuses every skipped mode and allows the loading ones', () => {
    const vanilla = freshRom()
    for (let mode = 0; mode < 32; mode++) {
      expect(L2LoaderReal.levelModeLoadsL2Objects(vanilla, mode), `mode ${mode}`).toBe(!SKIPPED.includes(mode)) // prettier-ignore
    }
  })
})
