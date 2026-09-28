/**
 * Per-tile switch alternates (#574), for the Map16 view and the map tab: one frame-0 picture for every
 * non-empty set of the switches a tile's own chars follow
 * (`switchesForChars`, never a tile-id list), kinds sorted. A single switch
 * whose picture equals the tile's own is dropped, since its toggle would
 * change nothing. `vram` must be the one the tile itself is drawn from.
 */
import {
  slotTiles,
  switchesForChars,
  type AnimationData,
  type AnimFrameSlot,
  type SwitchKind,
  type SwitchState,
} from './AnimationLoader'
import type { VramState } from './GfxLoader'
import type { RgbaColor } from './GraphicsDecoder'
import type { Map16Tile } from './Map16'
import { renderMap16Tile } from './TileRenderer'
import { vramFromChars } from './model/chars/CharFactory'
import { isBlank } from './render/HiddenTiles'

export interface TileAlternate {
  kinds: SwitchKind[]
  rgba: Uint8ClampedArray
  /** Blank with the switches off, drawn with them on. */
  hidden: boolean
}

/** Frame 0's alternate pixels for every char a switch in `kinds` changes, under all of them at once. */
function switchCharPixels(
  frameZeroSlots: readonly AnimFrameSlot[],
  kinds: ReadonlySet<SwitchKind>,
): Map<number, Uint8Array> {
  const state: SwitchState = {
    blue: kinds.has('blue'),
    silver: kinds.has('silver'),
    onOff: kinds.has('onOff'),
  }
  const out = new Map<number, Uint8Array>()
  for (const slot of frameZeroSlots) {
    if (!slot.alt || !kinds.has(slot.alt.switch)) continue
    slotTiles(slot, state).forEach((px, i) => out.set(slot.charBase + i, px))
  }
  return out
}

/** Every non-empty subset of `kinds`, in `kinds`' order: at most 7 for 3 switches. */
function nonEmptySubsets<T>(kinds: readonly T[]): T[][] {
  const subsets: T[][] = []
  for (let mask = 1; mask < 1 << kinds.length; mask++)
    subsets.push(kinds.filter((_, i) => mask & (1 << i)))
  return subsets
}

/** `vram` with every char a switch in `kinds` changes swapped to its frame-0 switched pixels. */
export function switchedVram(
  animData: AnimationData,
  vram: VramState,
  kinds: ReadonlySet<SwitchKind>,
): VramState {
  return vramFromChars(vram, switchCharPixels(animData.frames[0] ?? [], kinds))
}

/** A tile that follows a switch: its switches-off picture and its alternates. */
export interface TileSwitchArt {
  off: Uint8ClampedArray
  alts: TileAlternate[]
}

/** Every switch-following tile's switches-off picture and alternates, from its own chars. */
export function switchArtOf(
  animData: AnimationData,
  entries: readonly Map16Tile[],
  vram: VramState,
  palette: { colors: RgbaColor[] },
): Map<number, TileSwitchArt> {
  const patchedBySet = new Map<string, VramState>()
  const perTile = new Map<number, TileSwitchArt>()
  for (const tile of entries) {
    if (!tile) continue
    const chars = [tile.tl.charNum, tile.tr.charNum, tile.bl.charNum, tile.br.charNum]
    const kinds = [...switchesForChars(animData, chars)].sort()
    if (kinds.length === 0) continue
    const off = renderMap16Tile(tile, vram, palette)
    const offBlank = isBlank(off)
    const alts: TileAlternate[] = []
    for (const subset of nonEmptySubsets(kinds)) {
      const key = subset.join('+')
      let patched = patchedBySet.get(key)
      if (!patched) {
        patched = switchedVram(animData, vram, new Set(subset))
        patchedBySet.set(key, patched)
      }
      const rgba = renderMap16Tile(tile, patched, palette)
      if (subset.length === 1 && Buffer.from(rgba).equals(Buffer.from(off))) continue
      alts.push({ kinds: subset, rgba, hidden: offBlank && !isBlank(rgba) })
    }
    perTile.set(tile.id, { off, alts })
  }
  return perTile
}

/** `switchArtOf`'s alternates alone, for the Map16 view's wire form. */
export function tileAlternates(
  animData: AnimationData,
  entries: readonly Map16Tile[],
  vram: VramState,
  palette: { colors: RgbaColor[] },
): Map<number, TileAlternate[]> {
  return new Map([...switchArtOf(animData, entries, vram, palette)].map(([id, a]) => [id, a.alts]))
}
