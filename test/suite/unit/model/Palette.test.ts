import { describe, it, expect } from 'vitest'
import { computed, ref } from '@vue/reactivity'
import { existsSync } from 'fs'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { Color } from '../../../../src/rom/model/palette/Color'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { buildPalette } from '../../../../src/rom/model/palette/PaletteFactory'
import { StaticColor } from '../../../../src/rom/model/palette/behaviors/StaticColor'
import { CyclingColor } from '../../../../src/rom/model/palette/behaviors/CyclingColor'
import type { RenderContext } from '../../../../src/rom/model/RenderTarget'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

function mockCtx(palAnimFrame = 0): RenderContext {
  return {
    animFrame: ref(0),
    palAnimFrame: ref(palAnimFrame),
    pSwitchActive: ref(false),
    switchPalaceState: ref<readonly [boolean, boolean, boolean, boolean]>([false, false, false, false]),
    palette: null as never,
    camera: ref({ tileX: 0, tileY: 0, focused: false }),
    zoom: ref(1),
    layerToggles: ref({ l1: true, l2: true, sprites: true, screens: true, block: true, mapGrid: false }),
  }
}

function uniformPalette(color: RgbaColor): Palette {
  const cells = Array.from({ length: 16 }, () =>
    Array.from({ length: 16 }, () => new Color(new StaticColor(color))),
  )
  return new Palette(cells, new Color(new StaticColor(color)))
}

describe('Reactivity integration', () => {
  it('computed() wrapping CyclingColor.rgba invalidates only when palAnimFrame changes', () => {
    const ctx = mockCtx(0)
    const color = new Color(
      new CyclingColor([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
      ]),
    )
    const reactive = computed(() => color.rgba(ctx))

    expect(reactive.value).toEqual([255, 0, 0, 255])

    // Unrelated ref change leaves cache intact
    ctx.animFrame.value = 5
    ctx.pSwitchActive.value = true
    expect(reactive.value).toEqual([255, 0, 0, 255])

    // palAnimFrame change invalidates; next .value recomputes
    ctx.palAnimFrame.value = 1
    expect(reactive.value).toEqual([0, 255, 0, 255])
  })

  it('computed() wrapping StaticColor.rgba never recomputes', () => {
    const ctx = mockCtx(0)
    let rgbaCalls = 0
    const staticInstrumented = {
      rgba: () => {
        rgbaCalls++
        return [10, 20, 30, 255] as RgbaColor
      },
    }
    const color = new Color(staticInstrumented)
    const reactive = computed(() => color.rgba(ctx))

    expect(reactive.value).toEqual([10, 20, 30, 255])
    expect(rgbaCalls).toBe(1)

    ctx.palAnimFrame.value = 7
    ctx.animFrame.value = 3
    expect(reactive.value).toEqual([10, 20, 30, 255])
    expect(rgbaCalls).toBe(1) // Never recomputed because no refs were read
  })
})

describe('Color behaviors', () => {
  it('StaticColor returns the stored rgba unchanged', () => {
    const c = new Color(new StaticColor([10, 20, 30, 255]))
    expect(c.rgba(mockCtx())).toEqual([10, 20, 30, 255])
  })

  it('CyclingColor cycles through frames based on ctx.palAnimFrame', () => {
    const frames: RgbaColor[] = [
      [255, 255, 0, 255],
      [200, 200, 0, 255],
      [150, 150, 0, 255],
    ]
    const c = new Color(new CyclingColor(frames))
    expect(c.rgba(mockCtx(0))).toEqual([255, 255, 0, 255])
    expect(c.rgba(mockCtx(1))).toEqual([200, 200, 0, 255])
    expect(c.rgba(mockCtx(2))).toEqual([150, 150, 0, 255])
    // wraps
    expect(c.rgba(mockCtx(3))).toEqual([255, 255, 0, 255])
  })
})

describe('Palette', () => {
  it('row(idx, ctx) materializes each cell via its behavior', () => {
    const black: RgbaColor = [0, 0, 0, 255]
    const palette = uniformPalette(black)
    const row = palette.row(5, mockCtx())
    expect(row).toHaveLength(16)
    for (const col of row) expect(col).toEqual(black)
  })

  it('row() returns the shared scratch buffer (hot-path alloc elision)', () => {
    const palette = uniformPalette([0, 0, 0, 255])
    const a = palette.row(5, mockCtx())
    const b = palette.row(5, mockCtx())
    expect(a).toBe(b)
  })

  it('mixed static + cycling cells co-exist in one palette', () => {
    const black: RgbaColor = [0, 0, 0, 255]
    const cells: Color[][] = Array.from({ length: 16 }, () =>
      Array.from({ length: 16 }, () => new Color(new StaticColor(black))),
    )
    const yellowFrames: RgbaColor[] = [
      [255, 255, 0, 255],
      [200, 200, 0, 255],
    ]
    cells[6][4] = new Color(new CyclingColor(yellowFrames))
    const palette = new Palette(cells, new Color(new StaticColor(black)))

    const row6f0 = palette.row(6, mockCtx(0))
    expect(row6f0[4]).toEqual([255, 255, 0, 255])
    expect(row6f0[3]).toEqual(black)

    const row6f1 = palette.row(6, mockCtx(1))
    expect(row6f1[4]).toEqual([200, 200, 0, 255])

    // Unrelated row unaffected by palAnimFrame changes
    const row3 = palette.row(3, mockCtx(1))
    for (const col of row3) expect(col).toEqual(black)
  })

  it('stacking multiple animated cells in different rows works without wrappers', () => {
    const black: RgbaColor = [0, 0, 0, 255]
    const cells: Color[][] = Array.from({ length: 16 }, () =>
      Array.from({ length: 16 }, () => new Color(new StaticColor(black))),
    )
    cells[6][13] = new Color(new CyclingColor([[255, 255, 0, 255]]))
    cells[7][13] = new Color(new CyclingColor([[255, 0, 0, 255]]))
    const palette = new Palette(cells, new Color(new StaticColor(black)))

    expect(palette.row(6, mockCtx())[13]).toEqual([255, 255, 0, 255])
    expect(palette.row(7, mockCtx())[13]).toEqual([255, 0, 0, 255])
  })
})

describe.skipIf(!existsSync(ROM_PATH))('PaletteFactory (vanilla ROM)', () => {
  it('buildPalette produces a 16x16 Color grid from the level CGRAM', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0)!
    const header = parseLevelHeader(raw)

    const palette = buildPalette(rom.rom, header)

    expect(palette).toBeInstanceOf(Palette)
    expect(palette.cells).toHaveLength(16)
    expect(palette.cells[0]).toHaveLength(16)
    expect(palette.cells[0][0]).toBeInstanceOf(Color)
    expect(palette.cells[0][0].behavior).toBeInstanceOf(StaticColor)

    // Col 0 is transparent per SNES convention; col 1+ has real colors
    for (let r = 0; r < 16; r++) {
      const row = palette.row(r, mockCtx())
      expect(row[0][3]).toBe(0)
      expect(row[1][3]).toBe(255)
    }

    // backAreaColor is a Color — could be re-wrapped as animated in principle
    expect(palette.backAreaColor).toBeInstanceOf(Color)
    expect(palette.backAreaColor.rgba(mockCtx())).toHaveLength(4)
  })
})
