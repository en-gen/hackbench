import { describe, it, expect } from 'vitest'
import {
  chunk,
  linkedIndices,
  animatedColumns,
  targetFor,
  framePhase,
  tabTitle,
  cellTitle,
  viewWidgetId,
} from '../../../theia/extension/src/browser/palette-view-model'
import type {
  PaletteAnimTargetDto,
  PaletteGroupDto,
} from '../../../theia/extension/src/common/palette-protocol'

const target = (cgramIdx: number): PaletteAnimTargetDto => ({
  cgramIdx,
  frameStride: 4,
  intervalMs: 67,
  sharedWithOtherTargets: false,
  timing: { maskAddr: 0x00a423, mask: 0x1c, shift: 1, counterDp: 0x14 },
  frames: [],
})

const group = (over: Partial<PaletteGroupDto> = {}): PaletteGroupDto => ({
  id: 'sprite_sets',
  label: 'Shared Sprite Colors',
  description: '',
  cgRamRow: 4,
  variants: [{ label: 'Shared', romAddr: 0x00b250, rows: [] }],
  ...over,
})

describe('chunk', () => {
  it('wraps 9 frames into 8 + 1 and 17 into 8 + 8 + 1', () => {
    expect(chunk([...Array(9).keys()], 8).map(r => r.length)).toEqual([8, 1])
    expect(chunk([...Array(17).keys()], 8).map(r => r.length)).toEqual([8, 8, 1])
    expect(chunk([], 8)).toEqual([])
  })
})

describe('linkedIndices', () => {
  it('returns every frame sharing the selected frame word', () => {
    const frames = [0xb60c, 0xb60e, 0xb60c, 0xb610].map(romAddr => ({ romAddr }))
    expect([...linkedIndices(frames, 0)]).toEqual([0, 2])
    expect([...linkedIndices(frames, 3)]).toEqual([3])
  })
})

describe('animatedColumns / targetFor', () => {
  it('maps a CGRAM index to its row and column', () => {
    expect([...animatedColumns([target(0x64)], 6)]).toEqual([4])
    expect(animatedColumns([target(0x64)], 5).size).toBe(0)
    expect(targetFor([target(0x64)], 6, 4)?.cgramIdx).toBe(0x64)
    expect(targetFor([target(0x64)], 6, 5)).toBeUndefined()
  })

  it('has no markers for a row with no CGRAM row (Back Area Colors)', () => {
    expect(animatedColumns([target(0x00)], null).size).toBe(0)
    expect(targetFor([target(0x00)], null, 0)).toBeUndefined()
  })
})

describe('framePhase', () => {
  it('advances one frame per stride of game frames and wraps', () => {
    expect([0, 3, 4, 7, 8, 31, 32].map(f => framePhase(f, 4, 8))).toEqual([0, 0, 1, 1, 2, 7, 0])
  })
})

describe('titles and ids', () => {
  it('names a group tab, a variant tab and a cell', () => {
    const g = group({
      id: 'bg',
      label: 'Layer 2 Background',
      variants: [0, 1, 2, 3].map(i => ({ label: `Variant ${i}`, romAddr: null, rows: [] })),
    })
    expect(tabTitle(g, undefined)).toBe('Layer 2 Background')
    expect(tabTitle(g, 3)).toBe('Layer 2 Background · Variant 3')
    expect(cellTitle(g, 1, 4)).toBe('CGRAM $14 · Layer 2 Background')
    expect(cellTitle(group({ label: 'Back Area Colors', cgRamRow: null }), null, 3)).toBe(
      'Back Area Colors · 3',
    )
    expect(viewWidgetId('bg', undefined)).toBe('hackbench.palette-group-view:bg')
    expect(viewWidgetId('bg', 3)).toBe('hackbench.palette-group-view:bg:3')
  })
})
