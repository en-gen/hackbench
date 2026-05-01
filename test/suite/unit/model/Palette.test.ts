import { describe, it, expect, beforeEach } from 'vitest'
import { computed } from '@vue/reactivity'
import { existsSync } from 'fs'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { parseLevelHeader } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { Color } from '../../../../src/rom/model/palette/Color'
import { Palette } from '../../../../src/rom/model/palette/Palette'
import { buildPalette } from '../../../../src/rom/model/palette/PaletteFactory'
import { StaticColorBehavior } from '../../../../src/rom/model/palette/behaviors/StaticColorBehavior'
import { CyclingColorBehavior } from '../../../../src/rom/model/palette/behaviors/CyclingColorBehavior'
import { editorStore, resetEditorStore } from '../fixtures/stores'

const ROM_PATH = `${process.env.USERPROFILE ?? process.env.HOME}/Super Mario World (USA).vanilla.sfc`

function uniformPalette(color: RgbaColor): Palette {
  const cells = Array.from({ length: 16 }, () =>
    Array.from({ length: 16 }, () => new Color(new StaticColorBehavior(color))),
  )
  return new Palette(cells, new Color(new StaticColorBehavior(color)))
}

describe('Reactivity integration', () => {
  beforeEach(resetEditorStore)

  it('computed() wrapping CyclingColorBehavior.rgba invalidates only when palAnimFrame changes', () => {
    const color = new Color(
      new CyclingColorBehavior([
        [255, 0, 0, 255],
        [0, 255, 0, 255],
      ]),
    )
    editorStore.setPalAnimFrame(0)
    const reactive = computed(() => color.rgba())

    expect(reactive.value).toEqual([255, 0, 0, 255])

    // Unrelated store change leaves cache intact
    editorStore.setPSwitch(true)
    expect(reactive.value).toEqual([255, 0, 0, 255])

    // palAnimFrame change invalidates; next .value recomputes
    editorStore.setPalAnimFrame(1)
    expect(reactive.value).toEqual([0, 255, 0, 255])
  })

  it('computed() wrapping StaticColorBehavior.rgba never recomputes', () => {
    let rgbaCalls = 0
    const staticInstrumented = {
      rgba: () => {
        rgbaCalls++
        return [10, 20, 30, 255] as RgbaColor
      },
    }
    const color = new Color(staticInstrumented)
    editorStore.setPalAnimFrame(0)
    const reactive = computed(() => color.rgba())

    expect(reactive.value).toEqual([10, 20, 30, 255])
    expect(rgbaCalls).toBe(1)

    editorStore.setPalAnimFrame(7)
    expect(reactive.value).toEqual([10, 20, 30, 255])
    expect(rgbaCalls).toBe(1) // Never recomputed because no store reads
  })
})

describe('Color behaviors', () => {
  beforeEach(resetEditorStore)

  it('StaticColorBehavior returns the stored rgba unchanged', () => {
    const c = new Color(new StaticColorBehavior([10, 20, 30, 255]))
    expect(c.rgba()).toEqual([10, 20, 30, 255])
  })

  it('CyclingColorBehavior cycles through frames based on editorStore.palAnimFrame', () => {
    const frames: RgbaColor[] = [
      [255, 255, 0, 255],
      [200, 200, 0, 255],
      [150, 150, 0, 255],
    ]
    const c = new Color(new CyclingColorBehavior(frames))
    editorStore.setPalAnimFrame(0); expect(c.rgba()).toEqual([255, 255, 0, 255])
    editorStore.setPalAnimFrame(1); expect(c.rgba()).toEqual([200, 200, 0, 255])
    editorStore.setPalAnimFrame(2); expect(c.rgba()).toEqual([150, 150, 0, 255])
    // wraps
    editorStore.setPalAnimFrame(3); expect(c.rgba()).toEqual([255, 255, 0, 255])
  })
})

describe('Palette', () => {
  beforeEach(resetEditorStore)

  it('row(idx) materializes each cell via its behavior', () => {
    const black: RgbaColor = [0, 0, 0, 255]
    const palette = uniformPalette(black)
    const row = palette.row(5)
    expect(row).toHaveLength(16)
    for (const col of row) expect(col).toEqual(black)
  })

  it('row() returns the shared scratch buffer (hot-path alloc elision)', () => {
    const palette = uniformPalette([0, 0, 0, 255])
    const a = palette.row(5)
    const b = palette.row(5)
    expect(a).toBe(b)
  })

  it('mixed static + cycling cells co-exist in one palette', () => {
    const black: RgbaColor = [0, 0, 0, 255]
    const cells: Color[][] = Array.from({ length: 16 }, () =>
      Array.from({ length: 16 }, () => new Color(new StaticColorBehavior(black))),
    )
    const yellowFrames: RgbaColor[] = [
      [255, 255, 0, 255],
      [200, 200, 0, 255],
    ]
    cells[6][4] = new Color(new CyclingColorBehavior(yellowFrames))
    const palette = new Palette(cells, new Color(new StaticColorBehavior(black)))

    editorStore.setPalAnimFrame(0)
    const row6f0 = palette.row(6).slice()
    expect(row6f0[4]).toEqual([255, 255, 0, 255])
    expect(row6f0[3]).toEqual(black)

    editorStore.setPalAnimFrame(1)
    const row6f1 = palette.row(6).slice()
    expect(row6f1[4]).toEqual([200, 200, 0, 255])

    // Unrelated row unaffected by palAnimFrame changes
    const row3 = palette.row(3)
    for (const col of row3) expect(col).toEqual(black)
  })

  it('stacking multiple animated cells in different rows works without wrappers', () => {
    const black: RgbaColor = [0, 0, 0, 255]
    const cells: Color[][] = Array.from({ length: 16 }, () =>
      Array.from({ length: 16 }, () => new Color(new StaticColorBehavior(black))),
    )
    cells[6][13] = new Color(new CyclingColorBehavior([[255, 255, 0, 255]]))
    cells[7][13] = new Color(new CyclingColorBehavior([[255, 0, 0, 255]]))
    const palette = new Palette(cells, new Color(new StaticColorBehavior(black)))

    expect(palette.row(6)[13]).toEqual([255, 255, 0, 255])
    expect(palette.row(7)[13]).toEqual([255, 0, 0, 255])
  })
})

describe.skipIf(!existsSync(ROM_PATH))('PaletteFactory (vanilla ROM)', () => {
  beforeEach(resetEditorStore)

  it('buildPalette produces a 16x16 Color grid from the level CGRAM', () => {
    const rom = SmwRom.open(ROM_PATH)
    const raw = rom.getLevelRawData(0)!
    const header = parseLevelHeader(raw)

    const palette = buildPalette(rom.rom, header)

    expect(palette).toBeInstanceOf(Palette)
    expect(palette.cells).toHaveLength(16)
    expect(palette.cells[0]).toHaveLength(16)
    expect(palette.cells[0][0]).toBeInstanceOf(Color)
    expect(palette.cells[0][0].behavior).toBeInstanceOf(StaticColorBehavior)

    // Col 0 is transparent per SNES convention; col 1+ has real colors
    for (let r = 0; r < 16; r++) {
      const row = palette.row(r)
      expect(row[0][3]).toBe(0)
      expect(row[1][3]).toBe(255)
    }

    // backAreaColor is a Color — could be re-wrapped as animated in principle
    expect(palette.backAreaColor).toBeInstanceOf(Color)
    expect(palette.backAreaColor.rgba()).toHaveLength(4)
  })
})
