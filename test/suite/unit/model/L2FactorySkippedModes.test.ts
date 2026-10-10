/**
 * #637: the game's LoadLevel never runs the Layer 2 pass in six level modes
 * (SMWDisX bank_05.asm:444-457), so `buildL2` must not expand an L2 object
 * stream there. Synthetic ROM; the stream reader is mocked so the test can
 * see whether it was asked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import * as L2LoaderReal from '../../../../src/rom/L2Loader'
import type * as L2LoaderMod from '../../../../src/rom/L2Loader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { buildL2 } from '../../../../src/rom/model/L2Factory'

vi.mock('../../../../src/rom/L2Loader', async importOriginal => {
  const real = await importOriginal<typeof L2LoaderMod>()
  return { ...real, loadL2Objects: vi.fn(real.loadL2Objects) }
})
afterEach(() => vi.mocked(L2LoaderReal.loadL2Objects).mockReset())

const LEVEL = 5
const SKIPPED = [0x0a, 0x0c, 0x0d, 0x0e, 0x11, 0x1e]

describe('buildL2 in level modes without a Layer 2 pass (synthetic)', () => {
  const rom = new RomFile('l2.sfc', Buffer.alloc(0x80000, 0))
  rom.writeAt(0x05e600 + LEVEL * 3, [0x00, 0x90, 0x0c]) // an object-stream L2 pointer, not a $FF preset

  it('builds no L2 in exactly the six skipped modes, sweeping all 32', () => {
    for (let mode = 0; mode < 32; mode++) {
      vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid: [[1]] })
      const header = parseLevelHeader(Uint8Array.from([0, mode, 0, 0, 0]))
      const l2 = buildL2(rom, LEVEL, header, 1, false, new Map(), new Map(), new Map(), null, 0, new Array<number>(32).fill(0)) // prettier-ignore
      const read = vi.mocked(L2LoaderReal.loadL2Objects).mock.calls.length > 0
      expect([l2 === null, read], `mode ${mode}`).toEqual(SKIPPED.includes(mode) ? [true, false] : [false, true]) // prettier-ignore
      vi.mocked(L2LoaderReal.loadL2Objects).mockReset()
    }
  })
})
