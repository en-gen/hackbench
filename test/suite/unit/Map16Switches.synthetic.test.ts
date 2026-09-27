/**
 * The per-tile switch alternates map16-decode.ts builds for #574. No ROM: every
 * AnimationData, Map16Tile, VramState and palette is built here.
 */
import { describe, it, expect } from 'vitest'
import { PIXELS_PER_TILE, type RgbaColor } from '../../../src/rom/GraphicsDecoder'
import { VRAM_CHAR_BASE, type VramState } from '../../../src/rom/GfxLoader'
import {
  getSwitchedChars,
  type AnimationData,
  type AnimFrameSlot,
  type SwitchKind,
} from '../../../src/rom/AnimationLoader'
import type { Map16Tile, SubTile } from '../../../src/rom/Map16'
import type { ActiveLevelPalette } from '../../../src/rom/PaletteLoader'
import {
  buildSwitchNotes,
  buildTileAlternates,
  tileCitesAny,
} from '../../../theia/extension/src/node/map16-decode'

const CHAR_BASE = VRAM_CHAR_BASE.fg1

/** A tile whose top half cites `top` and bottom half `bottom` (both `top` by default). */
function tileCiting(id: number, top: number, bottom = top): Map16Tile {
  const sub = (charNum: number): SubTile => ({
    charNum,
    palette: 0,
    priority: false,
    flipX: false,
    flipY: false,
  })
  return { id, tl: sub(top), tr: sub(top), bl: sub(bottom), br: sub(bottom) }
}

const solid = (index: number): Uint8Array => new Uint8Array(PIXELS_PER_TILE).fill(index)

/** Row 0: index 1 is (10,20,30), index 2 is (40,50,60), index 3 is (70,80,90). */
function stubPalette(): ActiveLevelPalette {
  const row: RgbaColor[] = Array.from({ length: 16 }, (_, i) =>
    i === 0 ? [0, 0, 0, 0] : [i * 30 - 20, i * 30 - 10, i * 30, 255],
  )
  const rows = Array.from({ length: 16 }, () => row)
  return { colors: rows.flat(), rows, bgVariantIndex: 0, fgVariantIndex: 0, spritePaletteIndex: 0 }
}
const palette = stubPalette()

/** A frame-0 slot covering `charNum`'s 4-char group, with `alt` switched by `kind`. */
function slot(
  charNum: number,
  normal: Uint8Array,
  alt: Uint8Array,
  kind: SwitchKind,
): AnimFrameSlot {
  const tiles = Array.from({ length: 4 }, () => normal)
  const altTiles = Array.from({ length: 4 }, () => alt)
  return { charBase: charNum - (charNum % 4), tiles, alt: { switch: kind, tiles: altTiles } }
}

/** Frame 0 holds `slots`; later frames are never read by the builder. */
const animDataOf = (...slots: AnimFrameSlot[]): AnimationData => ({
  frameCount: 4,
  intervalMs: 133,
  frames: [slots, [], [], []],
})

/** One blue-switched char with `normal` in VRAM, and the alternates of a tile citing it. */
function setup(normal: Uint8Array, alt: Uint8Array) {
  const vram: VramState = { fg1: Array.from({ length: 8 }, () => normal) }
  const tile = tileCiting(0, CHAR_BASE)
  return buildTileAlternates(
    animDataOf(slot(CHAR_BASE, normal, alt, 'blue')),
    [tile],
    vram,
    palette,
  )
}

const firstPixel = (base64: string): number[] => [...Buffer.from(base64, 'base64').subarray(0, 3)]

describe('buildTileAlternates', () => {
  it('gives a tile an alternate only when its chars have a frame-0 switched slot', () => {
    const vram: VramState = { fg1: Array.from({ length: 8 }, () => solid(1)) }
    const data = animDataOf(slot(CHAR_BASE, solid(1), solid(2), 'blue'))
    const result = buildTileAlternates(
      data,
      [tileCiting(0, CHAR_BASE), tileCiting(1, CHAR_BASE + 4)],
      vram,
      palette,
    )
    expect([...result.keys()]).toEqual([0])
    expect(result.get(0)!.map(a => a.kinds)).toEqual([['blue']])
  })

  it('composites the alternate from the alt pixels, not the normal ones', () => {
    expect(firstPixel(setup(solid(1), solid(2)).get(0)![0]!.altRgbaBase64)).toEqual([40, 50, 60])
  })

  it.each([
    ['blank off, opaque on', 0, 2, true],
    ['already opaque off', 1, 2, false],
  ])('hidden: %s -> %s', (_, off, on, hidden) => {
    expect(setup(solid(off), solid(on)).get(0)![0]!.hidden).toBe(hidden)
  })

  it.each([
    ['opaque', 1],
    ['blank', 0],
  ])('drops a switch whose alternate draws the same %s art as the tile', (_, index) => {
    // The char is switched, but its alternate pixels equal its normal ones: no toggle.
    expect(setup(solid(index), solid(index)).get(0)).toEqual([])
  })

  it('keeps a toggle whose alternate is opaque black over a blank tile: alpha counts (D2)', () => {
    const black = stubPalette()
    black.rows[0]![5] = [0, 0, 0, 255]
    black.colors[5] = [0, 0, 0, 255]
    const vram: VramState = { fg1: Array.from({ length: 8 }, () => solid(0)) }
    const data = animDataOf(slot(CHAR_BASE, solid(0), solid(5), 'blue'))
    const alts = buildTileAlternates(data, [tileCiting(0, CHAR_BASE)], vram, black).get(0)!
    expect(alts.map(a => [a.kinds, a.hidden])).toEqual([[['blue'], true]])
  })

  it('drops only the switch that changes nothing, keeping the one that does', () => {
    const [top, bottom] = [CHAR_BASE, CHAR_BASE + 4]
    const data = animDataOf(
      slot(top, solid(1), solid(1), 'silver'),
      slot(bottom, solid(1), solid(3), 'blue'),
    )
    const vram: VramState = { fg1: Array.from({ length: 8 }, () => solid(1)) }
    const alts = buildTileAlternates(data, [tileCiting(0, top, bottom)], vram, palette).get(0)!
    expect(alts.filter(a => a.kinds.length === 1).map(a => a.kinds)).toEqual([['blue']])
  })

  it('gives one alternate per non-empty switch set, the pair composing both halves', () => {
    const [top, bottom] = [CHAR_BASE, CHAR_BASE + 4]
    const data = animDataOf(
      slot(top, solid(1), solid(2), 'silver'),
      slot(bottom, solid(1), solid(3), 'blue'),
    )
    const vram: VramState = { fg1: Array.from({ length: 8 }, () => solid(1)) }
    const alts = buildTileAlternates(data, [tileCiting(0, top, bottom)], vram, palette).get(0)!
    expect(alts.map(a => a.kinds)).toEqual([['blue'], ['silver'], ['blue', 'silver']])
    const both = Buffer.from(alts[2]!.altRgbaBase64, 'base64')
    const at = (y: number): number[] => [...both.subarray(y * 64, y * 64 + 3)]
    expect([at(0), at(15)]).toEqual([
      [40, 50, 60],
      [70, 80, 90],
    ])
  })
})

describe('buildSwitchNotes', () => {
  const four = [solid(1), solid(1), solid(1), solid(1)]
  // The routine read failed: slot $40 is switched (alternate unread), slot $80 only animates.
  const failed: AnimationData = {
    ...animDataOf({ charBase: 0x40, tiles: four, switched: true }, { charBase: 0x80, tiles: four }),
    switchUnavailable: 'the level animation call reaches $13AC77, not CODE_05BB39',
  }
  const [switched, animated, plain] = [
    tileCiting(1, 0x41),
    tileCiting(2, 0x81),
    tileCiting(3, 0x10),
  ]

  it('notes a tile citing a switched char when the switch read failed (N17)', () => {
    const notes = buildSwitchNotes(failed, [switched, animated, plain], new Map())
    expect(notes.get(1)).toBe(failed.switchUnavailable)
  })

  it('never notes a tile whose chars only animate, or do neither (N18)', () => {
    const notes = buildSwitchNotes(failed, [switched, animated, plain], new Map())
    expect([...notes.keys()]).toEqual([1])
  })

  it('never notes a resolved tile, even one whose every toggle was dropped (D3)', () => {
    expect(buildSwitchNotes(failed, [switched], new Map([[1, []]])).size).toBe(0)
  })

  it('notes nothing when every switch was read', () => {
    const read: AnimationData = { ...failed, switchUnavailable: undefined }
    expect(buildSwitchNotes(read, [switched], new Map()).size).toBe(0)
  })
})

describe('tileCitesAny', () => {
  const tile = tileCiting(0, CHAR_BASE)
  it.each([
    ['no char set', undefined, false],
    ['a cited char', new Set([CHAR_BASE]), true],
    ['no cited char', new Set([CHAR_BASE + 99]), false],
  ])('%s -> %s', (_, chars, expected) => {
    expect(tileCitesAny(tile, chars)).toBe(expected)
  })
})

describe('getSwitchedChars', () => {
  it('names the chars of switched slots only, whether or not their alternate was read', () => {
    const data = animDataOf(
      { charBase: 0x40, tiles: [solid(1), solid(1), solid(1), solid(1)], switched: true },
      { charBase: 0x80, tiles: [solid(1), solid(1), solid(1), solid(1)] },
    )
    expect([...getSwitchedChars(data)]).toEqual([0x40, 0x41, 0x42, 0x43])
  })
})
