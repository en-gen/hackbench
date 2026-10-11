/**
 * #637: the game's LoadLevel loads no Layer 2 objects in ten level modes
 * (SMWDisX bank_05.asm:431-457), unless the level-load site is hijacked, so `buildL2` must not
 * expand an L2 object stream there. Synthetic ROM; the stream reader is mocked so the test can see
 * whether it was asked.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import * as L2LoaderReal from '../../../../src/rom/L2Loader'
import type * as L2LoaderMod from '../../../../src/rom/L2Loader'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { buildL2 } from '../../../../src/rom/model/L2Factory'
import { buildL2Inputs } from '../../../../src/rom/model/L2Model'
import type { L1Inputs } from '../../../../src/rom/model/L1Model'
import type { SmwRom } from '../../../../src/rom/SmwRom'
import { SKIP_CHAIN_AT, SKIP_CHAIN_B_AT, writeStockSkipChain } from '../../support/skipChain'
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
  writeStockSkipChain(rom)

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

  // Unreadable is not "not C9": with the site off the end of the ROM no stream is admitted (fail closed).
  it('an unreadable site admits no stream in a skipped mode', () => {
    const tiny = new RomFile('tiny.sfc', Buffer.alloc(0x1000, 0)) // a fresh copy: no shared state
    expect(L2LoaderReal.levelModeLoadsL2Objects(tiny, 0x0a)).toBe(false)
  })

  // Unknown is not a claim about the game: the refusal must not say the game loads no stream.
  it('an unreadable site is unrecognized, and the refusal does not claim game behaviour', () => {
    const real = rom.readByte.bind(rom)
    const spy = vi.spyOn(rom, 'readByte').mockImplementation(a => (a === SITE ? null : real(a)))
    try {
      expect(L2LoaderReal.l2ObjectGate(rom, 0x0a)).toBe('unrecognized')
      const header = parseLevelHeader(Uint8Array.from([0, 0x0a, 0, 0, 0]))
      const res = buildL2Inputs({ rom } as unknown as SmwRom, LEVEL, { screenCount: 1, isVertical: false, header } as unknown as L1Inputs) // prettier-ignore
      expect(res.ok).toBe(false)
      expect(res.ok ? '' : res.reason).not.toMatch(/loads no layer 2 objects/i)
    } finally {
      spy.mockRestore()
    }
  })

  // Hack-only path (D51): the skip branch is rerouted but CMP #$FF is stock; nothing is guessed.
  // Each case plants one change in a stock chain and restores it in finally, so a failure cannot leak.
  const withStockSite = (plant: () => void, expectGate: string) => {
    try {
      rom.writeAt(SITE, [0xc9])
      writeStockSkipChain(rom)
      expect(L2LoaderReal.l2ObjectGate(rom, 0x0a)).toBe('skipped')
      plant()
      expect(L2LoaderReal.l2ObjectGate(rom, 0x0a)).toBe(expectGate)
    } finally {
      writeStockSkipChain(rom)
      rom.writeAt(SITE, [0xc9])
    }
  }

  it('a changed skip chain with a stock site reports unrecognized, and no stream is read', () => {
    try {
      rom.writeAt(SITE, [0xc9])
      rom.writeAt(SKIP_CHAIN_B_AT + 5, [0xea, 0xea]) // the mode $0A compare is neutered
      expect(L2LoaderReal.l2ObjectGate(rom, 0x0a)).toBe('unrecognized')
      expect(L2LoaderReal.l2ObjectGate(rom, 0x03)).toBe('loads')
      vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid: [[1]] })
      expect(l2At(0x0a)).toBeNull()
      expect(vi.mocked(L2LoaderReal.loadL2Objects)).not.toHaveBeenCalled()
    } finally {
      writeStockSkipChain(rom)
    }
  })

  it('a BEQ that reaches a different target than the rest is unrecognized', () => {
    // +7 is the BEQ opcode, +8 its offset byte: changing the offset moves only the target.
    withStockSite(() => rom.writeAt(SKIP_CHAIN_B_AT + 8, [0x10]), 'unrecognized')
  })

  it('a changed first chain (mode $09 compare neutered) is unrecognized', () => {
    withStockSite(() => rom.writeAt(SKIP_CHAIN_AT + 3, [0xea, 0xea]), 'unrecognized')
  })

  it('a chain that loads a different address than LevelModeSetting is unrecognized', () => {
    withStockSite(() => rom.writeAt(SKIP_CHAIN_B_AT + 1, [0x00, 0x00]), 'unrecognized')
  })

  // Any byte but the stock CMP opcode is a hijack, not just JML ($5C): a mutant `=== 0x5C` must die.
  it('treats every non-CMP byte at the site as a hijack', () => {
    for (const byte of [0x22, 0x00, 0x4c]) {
      rom.writeAt(SITE, [byte])
      vi.mocked(L2LoaderReal.loadL2Objects).mockReturnValue({ grid: [[1]] })
      expect(l2At(0x0a), `site ${byte}`).not.toBeNull()
      vi.mocked(L2LoaderReal.loadL2Objects).mockReset()
    }
    rom.writeAt(SITE, [0xc9])
  })

  // The gate sits after the preset branch: a $FF pointer is a background image in every mode.
  it('still builds a $FF preset background in skipped modes on a stock site', () => {
    const preset = new RomFile('l2p.sfc', Buffer.alloc(0x80000, 0))
    preset.writeAt(0x05e600 + LEVEL * 3, [0x00, 0x80, 0xff])
    preset.writeAt(0x0c8000, [0x84, 0x07, 0xff, 0xff])
    preset.writeAt(SITE, [0xc9])
    for (const mode of [0x00, 0x0a]) {
      const header = parseLevelHeader(Uint8Array.from([0, mode, 0, 0, 0]))
      const l2 = buildL2(preset, LEVEL, header, 1, false, new Map(), new Map(), new Map(), null, 0, new Array<number>(32).fill(0)) // prettier-ignore
      expect(l2, `mode ${mode}`).not.toBeNull()
      expect(vi.mocked(L2LoaderReal.loadL2Objects), `mode ${mode}`).not.toHaveBeenCalled()
    }
  })
})

// Proves the gate is ON for the stock ROM (corpus only; the synthetic cases above run in CI).
describe.skipIf(!hasRom(VANILLA))('levelModeLoadsL2Objects on the vanilla ROM', () => {
  it('recognizes the stock skip chain', () => {
    expect(L2LoaderReal.l2ObjectGate(freshRom(), 0x0a)).toBe('skipped')
  })

  it('refuses every skipped mode and allows the loading ones', () => {
    const vanilla = freshRom()
    for (let mode = 0; mode < 32; mode++) {
      expect(L2LoaderReal.levelModeLoadsL2Objects(vanilla, mode), `mode ${mode}`).toBe(!SKIPPED.includes(mode)) // prettier-ignore
    }
  })
})
