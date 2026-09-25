/**
 * PaletteFactory.test.ts - branch coverage for buildPalette / collectPaletteAnimFrames
 * (src/rom/model/palette/PaletteFactory.ts).
 *
 * ROM dependencies are mocked so no ROM file is needed.
 *
 * Test tree:
 *   collectPaletteAnimFrames
 *     - loadPaletteAnimData returns null → empty map (all cells static)
 *     - all frames populated → cells with known cgramIdx get CyclingColorBehavior
 *     - partial frames (frames.some(f => !f)) → entry deleted, cell stays static
 *   buildPalette cell dispatch
 *     - cgramIdx in animByCgramIdx map → CyclingColorBehavior
 *     - cgramIdx not in map → StaticColorBehavior
 *   buildPalette back-area color
 *     - bgColor in range → uses loadBackAreaColors result
 *     - bgColor out of range (undefined) → fallback [0,0,0,255]  (?? branch)
 */

import { vi, describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'

// Hoist mocks before any module imports that would trigger real loading.
vi.mock('../../../../src/rom/PaletteLoader', () => ({
  loadRomPalettes: vi.fn(() => ({})),
  buildLevelCgram: vi.fn(),
  loadBackAreaColors: vi.fn(() => [] as RgbaColor[]),
  STOCK_COL1: { bg: 0x7fdd, obj: 0x7fff },
}))
vi.mock('../../../../src/rom/PaletteAnimationLoader', () => ({
  loadPaletteAnimData: vi.fn(() => null),
}))

import { buildPalette } from '../../../../src/rom/model/palette/PaletteFactory'
import { loadPaletteAnimData } from '../../../../src/rom/PaletteAnimationLoader'
import { buildLevelCgram, loadBackAreaColors } from '../../../../src/rom/PaletteLoader'
import { CyclingColorBehavior } from '../../../../src/rom/model/palette/behaviors/CyclingColorBehavior'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'

// ── Helpers ───────────────────────────────────────────────────────────────

const RED: RgbaColor = [255, 0, 0, 255]
const GREEN: RgbaColor = [0, 255, 0, 255]
const BLACK: RgbaColor = [0, 0, 0, 255]

/** Minimal header - only the fields PaletteFactory reads. */
const baseHeader = { bgPalette: 0, fgPalette: 0, spritePalette: 0, bgColor: 0 }

/** 1×1 CGRAM grid at cgramIdx 0 (row 0, col 0). */
function oneCell(color: RgbaColor = RED) {
  ;(buildLevelCgram as ReturnType<typeof vi.fn>).mockReturnValue({
    rows: [[color]],
  })
}

const fakeRom = null as never

beforeEach(() => {
  vi.mocked(loadPaletteAnimData).mockReturnValue(null)
  vi.mocked(loadBackAreaColors).mockReturnValue([BLACK])
  oneCell()
})

// ── collectPaletteAnimFrames - anim=null branch ───────────────────────────

describe('collectPaletteAnimFrames - loadPaletteAnimData returns null', () => {
  it('all cells get StaticColorBehavior when anim data is absent', () => {
    // Branch: `if (!anim) return out` in collectPaletteAnimFrames
    vi.mocked(loadPaletteAnimData).mockReturnValue(null)
    const pal = buildPalette(fakeRom, baseHeader)
    expect(pal.cells[0][0].behavior).toBeInstanceOf(StaticColorBehavior)
  })
})

// ── collectPaletteAnimFrames - frames fully populated ─────────────────────

describe('collectPaletteAnimFrames - anim frames present', () => {
  it('cell at the animated cgramIdx gets CyclingColorBehavior', () => {
    // Branch: `if (frames)` in buildPalette - animated cgramIdx found in map
    // Branch: `if (!frames)` in loop - first encounter allocates the array
    vi.mocked(loadPaletteAnimData).mockReturnValue({
      frameCount: 2,
      frames: [[{ cgramIdx: 0, color: RED }], [{ cgramIdx: 0, color: GREEN }]],
    })
    oneCell(RED)
    const pal = buildPalette(fakeRom, baseHeader)
    expect(pal.cells[0][0].behavior).toBeInstanceOf(CyclingColorBehavior)
  })

  it('cell NOT in the anim map keeps StaticColorBehavior', () => {
    // 2×1 grid: cgramIdx 0 is animated, cgramIdx 1 is not
    // Branch: `if (frames)` false path → StaticColorBehavior
    vi.mocked(loadPaletteAnimData).mockReturnValue({
      frameCount: 2,
      frames: [[{ cgramIdx: 0, color: RED }], [{ cgramIdx: 0, color: GREEN }]],
    })
    ;(buildLevelCgram as ReturnType<typeof vi.fn>).mockReturnValue({
      rows: [[RED, GREEN]], // two cells; cgramIdx=0 animated, cgramIdx=1 not
    })
    const pal = buildPalette(fakeRom, baseHeader)
    expect(pal.cells[0][0].behavior).toBeInstanceOf(CyclingColorBehavior)
    expect(pal.cells[0][1].behavior).toBeInstanceOf(StaticColorBehavior)
  })

  it('CyclingColorBehavior carries all animation frames', () => {
    vi.mocked(loadPaletteAnimData).mockReturnValue({
      frameCount: 2,
      frames: [[{ cgramIdx: 0, color: RED }], [{ cgramIdx: 0, color: GREEN }]],
    })
    oneCell(RED)
    const pal = buildPalette(fakeRom, baseHeader)
    const b = pal.cells[0][0].behavior as CyclingColorBehavior
    expect(b.frames).toHaveLength(2)
    expect(b.frames[0]).toEqual(RED)
    expect(b.frames[1]).toEqual(GREEN)
  })
})

// ── collectPaletteAnimFrames - partial frames pruned ─────────────────────

describe('collectPaletteAnimFrames - partial frames (some frames missing)', () => {
  it('cell with incomplete anim frames falls back to StaticColorBehavior', () => {
    // Branch: `if (frames.some(f => !f)) out.delete(idx)` - partial entry removed
    // Array.some skips sparse holes, so we must inject an explicitly falsy color
    // (null) to make the check trigger. This mirrors corrupted / partial ROM data.
    vi.mocked(loadPaletteAnimData).mockReturnValue({
      frameCount: 2,
      frames: [
        [{ cgramIdx: 0, color: RED }],
        [{ cgramIdx: 0, color: null as unknown as RgbaColor }], // explicit null → !f
      ],
    })
    oneCell(RED)
    const pal = buildPalette(fakeRom, baseHeader)
    expect(pal.cells[0][0].behavior).toBeInstanceOf(StaticColorBehavior)
  })
})

// ── buildPalette - back-area color ────────────────────────────────────────

describe('buildPalette - back-area color fallback', () => {
  it('uses loadBackAreaColors[bgColor] when the index is in range', () => {
    // Branch: `?? [0,0,0,255]` - false path (index in range)
    const BLUE: RgbaColor = [0, 0, 255, 255]
    vi.mocked(loadBackAreaColors).mockReturnValue([BLUE])
    oneCell()
    const pal = buildPalette(fakeRom, { ...baseHeader, bgColor: 0 })
    expect(pal.backAreaColor.behavior).toBeInstanceOf(StaticColorBehavior)
    expect(pal.backAreaColor.rgba()).toEqual(BLUE)
  })

  it('falls back to opaque black when bgColor index is out of range', () => {
    // Branch: `?? [0,0,0,255]` - true path (backAreas[bgColor] is undefined)
    vi.mocked(loadBackAreaColors).mockReturnValue([]) // empty → index 0 undefined
    oneCell()
    const pal = buildPalette(fakeRom, { ...baseHeader, bgColor: 0 })
    expect(pal.backAreaColor.rgba()).toEqual([0, 0, 0, 255])
  })
})
