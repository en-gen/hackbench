/**
 * Synthetic map inputs shared by the map-screen suites: a tiny Map16 table, the
 * chars and palette it draws from, and the switch animation over them. No ROM.
 */
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import {
  PIPE_VARIANT_TILE_COUNT,
  PIPE_VARIANT_TILE_START,
  type Map16Tile,
} from '../../../src/rom/Map16'
import type { VramState } from '../../../src/rom/GfxLoader'
import type { RgbaColor } from '../../../src/rom/GraphicsDecoder'
import { switchArtOf } from '../../../src/rom/SwitchAlternates'
import type { L1Inputs } from '../../../src/rom/model/L1Model'

export const BACKDROP: RgbaColor = [250, 9, 9, 255]

export const sub = (charNum: number, palette = 0, priority = false) => ({ charNum, palette, priority, flipX: false, flipY: false }) // prettier-ignore
export const tile = (id: number, q: ReturnType<typeof sub>[]): Map16Tile => ({ id, tl: q[0]!, tr: q[1]!, bl: q[2]!, br: q[3]! }) // prettier-ignore
/** fg1 chars 0-4, each solid in its own color index (char 0 transparent); 5 blank; 6 solid color 4; 7-9 blank. */
export const VRAM: VramState = {
  fg1: [0, 1, 2, 3, 4, 0, 4, 0, 0, 0].map(v => new Uint8Array(64).fill(v)),
}
/** The blue switch swaps chars 2-4 to solid color 7 and char 5's top half to color 7 (frame 0 as loaded when off). */
/** ON/OFF on blanks char 6: a tile drawn with the switch off, gone with it on. */
export const ONOFF_SLOT = { charBase: 6, tiles: [4, 0, 0, 0].map(v => new Uint8Array(64).fill(v)), alt: { switch: 'onOff' as const, tiles: [0, 1, 2, 3].map(() => new Uint8Array(64)) } } // prettier-ignore
export const BLUE_SLOT = { charBase: 2, tiles: [2, 3, 4, 0].map(v => new Uint8Array(64).fill(v)), alt: { switch: 'blue' as const, tiles: [0, 1, 2, 3].map(i => new Uint8Array(64).fill(7, 0, i === 3 ? 32 : 64)) } } // prettier-ignore

/** Color index c of row r is [r * 16 + c, 100, 200]; index 0 is transparent. */
export const COLORS: RgbaColor[] = Array.from({ length: 256 }, (_, i) => (i % 16 === 0 ? [0, 0, 0, 0] : [i, 100, 200, 255])) // prettier-ignore

const ANIM = { frameCount: 1, intervalMs: 100, frames: [[BLUE_SLOT, ONOFF_SLOT]] }

/**
 * Inputs with tile 1 (chars 1-4, one per quadrant), empty tile 0, tile 2
 * hidden until blue is on, tile 4 drawn until ON/OFF is on, and the eight
 * pipe tiles whose variant v draws char 1 in palette row v. Tiles sit at
 * their own ids, as the Map16 table does.
 */
export function inputs(
  grid: number[][],
  isVertical: boolean,
  screenCount: number,
  tileset = 0,
): L1Inputs {
  const tiles: Map16Tile[] = []
  const put = (t: Map16Tile) => (tiles[t.id] = t)
  put(tile(0, [sub(0), sub(0), sub(0), sub(0)]))
  put(tile(1, [sub(1), sub(2), sub(3), sub(4)]))
  put(tile(2, [sub(5), sub(5), sub(5), sub(5)])) // hidden: blank until blue is on
  put(tile(3, [sub(1), sub(1), sub(1), sub(1)])) // cites no switched char
  put(tile(4, [sub(6), sub(6), sub(6), sub(6)])) // vanishes: drawn until ON/OFF is on
  const pipeVariants = [0, 1, 2, 3].map(
    v =>
    Array.from({ length: PIPE_VARIANT_TILE_COUNT }, (_, i) => tile(PIPE_VARIANT_TILE_START + i, [sub(1, v), sub(1, v), sub(1, v), sub(1, v)])), // prettier-ignore
  )
  for (let i = 0; i < PIPE_VARIANT_TILE_COUNT; i++) put(tile(PIPE_VARIANT_TILE_START + i, [sub(0), sub(0), sub(0), sub(0)])) // prettier-ignore
  return {
    header: parseLevelHeader([0, 0, 0, 0, tileset]),
    isVertical,
    screenCount,
    grid,
    map16: { tiles, pipeVariants },
    rawVram: VRAM,
    anim: ANIM,
    vram: VRAM,
    colors: COLORS,
    backArea: BACKDROP,
    unverified: [],
    switchArt: switchArtOf(ANIM, tiles, VRAM, { colors: COLORS }),
    variantSwitchArt: pipeVariants.map(set => switchArtOf(ANIM, set, VRAM, { colors: COLORS })),
  }
}

export const hGrid = (screens: number) => Array.from({ length: 27 }, () => new Array<number>(screens * 16).fill(0)) // prettier-ignore
export const vGrid = (screens: number) => Array.from({ length: screens * 16 }, () => new Array<number>(32).fill(0)) // prettier-ignore

/** RGBA of pixel (x, y) in a screen buffer of `width` pixels. */
export const px = (buf: Uint8ClampedArray, width: number, x: number, y: number) =>
  Array.from(buf.subarray((y * width + x) * 4, (y * width + x) * 4 + 4))
