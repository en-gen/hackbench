/**
 * #560: the two ON/OFF track tiles, each a one-pixel diagonal, draw only in
 * their own switch state. Synthetic bytes in the shape vanilla's $094/$095
 * have (measured on the vanilla ROM: $094 an anti-diagonal drawn with ON/OFF
 * off, $095 a main diagonal drawn with ON/OFF on); no ROM, so CI runs it.
 */
import { describe, it, expect } from 'vitest'
import type { AnimationData } from '../../../src/rom/AnimationLoader'
import type { VramState } from '../../../src/rom/GfxLoader'
import { switchArtOf } from '../../../src/rom/SwitchAlternates'
import { HIDDEN_TILE_DIM_ALPHA, overlayHidden } from '../../../src/rom/render/HiddenTiles'
import { drawL1Planes } from '../../../theia/extension/src/node/map-screen'
import { COLORS, hGrid, inputs, sub, tile } from '../support/mapInputs'

/** An 8x8 char with a one-pixel diagonal in color 1: x === y, or x + y === 7. */
const diagonal = (anti: boolean): Uint8Array => {
  const c = new Uint8Array(64)
  for (let i = 0; i < 8; i++) c[i * 8 + (anti ? 7 - i : i)] = 1
  return c
}
const blank = () => new Uint8Array(64)

const FIRST = 8
const ANTI = FIRST // char 8: anti-diagonal, the track drawn with ON/OFF off
const MAIN = FIRST + 4 // char 12: blank until ON/OFF is on, then the main diagonal
const SHOWN_OFF = 20 // map16 id of the track drawn with ON/OFF off
const SHOWN_ON = 21 // map16 id of the track drawn with ON/OFF on

const fg1 = Array.from({ length: 16 }, () => blank())
fg1[ANTI] = diagonal(true)
const VRAM: VramState = { fg1 }
const ANIM: AnimationData = {
  frameCount: 1,
  intervalMs: 100,
  frames: [
    [
      { charBase: ANTI, tiles: [diagonal(true), blank(), blank(), blank()], alt: { switch: 'onOff', tiles: [blank(), blank(), blank(), blank()] } }, // prettier-ignore
      { charBase: MAIN, tiles: [blank(), blank(), blank(), blank()], alt: { switch: 'onOff', tiles: [diagonal(false), blank(), blank(), blank()] } }, // prettier-ignore
    ],
  ],
}

function model() {
  const m = inputs(hGrid(1), false, 1)
  m.map16.tiles[SHOWN_OFF] = tile(SHOWN_OFF, [sub(0), sub(ANTI), sub(ANTI), sub(0)])
  m.map16.tiles[SHOWN_ON] = tile(SHOWN_ON, [sub(MAIN), sub(0), sub(0), sub(MAIN)])
  m.grid[0]![0] = SHOWN_OFF
  m.grid[0]![1] = SHOWN_ON
  m.vram = m.rawVram = VRAM
  m.anim = ANIM
  m.switchArt = switchArtOf(ANIM, m.map16.tiles, VRAM, { colors: COLORS })
  return m
}

/** The alphas of cell `col`'s 16 track pixels, and of every other pixel in it. */
function alphas(onOff: boolean, col: number, anti: boolean) {
  const plane = drawL1Planes(model(), 0, { blue: false, silver: false, onOff }).l1Low!
  const on: number[] = []
  const off: number[] = []
  for (let y = 0; y < 16; y++)
    for (let x = 0; x < 16; x++) {
      const a = plane[(y * 256 + col * 16 + x) * 4 + 3]!
      const onTrack = anti ? x + y === 15 : x === y
      ;(onTrack ? on : off).push(a)
    }
  return { on, off }
}

describe('ON/OFF tracks draw only in their own switch state (#560)', () => {
  const dimmed = Math.round(255 * HIDDEN_TILE_DIM_ALPHA)
  it.each([
    ['the OFF track, ON/OFF off', false, 0, true, true],
    ['the OFF track, ON/OFF on', true, 0, true, false],
    ['the ON track, ON/OFF off', false, 1, false, false],
    ['the ON track, ON/OFF on', true, 1, false, true],
  ])('%s', (_, onOff, col, anti, drawn) => {
    const { on, off } = alphas(onOff, col, anti)
    // Nothing but the track's own pixels ever draws.
    expect(off.every(a => a === 0)).toBe(true)
    expect(on).toHaveLength(16)
    // Drawn: every pixel at full strength. Hidden: the screen door, never a full-strength pixel.
    // (`onOff` is $14AF == 1.)
    if (drawn) expect(on.every(a => a === 255)).toBe(true)
    else expect(on.every(a => a === dimmed)).toBe(true)
  })
})

describe('overlayHidden flips by majority (#560)', () => {
  const dimmed = Math.round(255 * HIDDEN_TILE_DIM_ALPHA)
  const picture = (cells: [number, number][]) => {
    const rgba = new Uint8ClampedArray(16 * 16 * 4)
    for (const [x, y] of cells) rgba.set([9, 9, 9, 255], (y * 16 + x) * 4)
    return rgba
  }
  const drawn = (cells: [number, number][]) => {
    const dst = new Uint8ClampedArray(16 * 16 * 4)
    overlayHidden(dst, 16, 0, 0, picture(cells))
    return cells.map(([x, y]) => dst[(y * 16 + x) * 4 + 3]!)
  }
  const diagonal: [number, number][] = Array.from({ length: 16 }, (_, i) => [i, i])

  it('a diagonal plus one odd pixel is still mostly dim, not 16 of 17 at full strength', () => {
    const alphas = drawn([...diagonal, [1, 0]])
    expect(alphas.filter(a => a === 255)).toHaveLength(1)
    expect(alphas.filter(a => a === dimmed)).toHaveLength(16)
  })

  it('a mixed-parity picture with no majority keeps the checkerboard', () => {
    const alphas = drawn([
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
    ])
    expect(alphas).toEqual([255, dimmed, 255, dimmed])
  })

  it('a dim majority is left alone', () => {
    expect(drawn([[1, 0], [3, 0], [0, 0]])).toEqual([dimmed, dimmed, 255]) // prettier-ignore
  })
})
