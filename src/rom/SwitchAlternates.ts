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
import { firstHiddenSingle } from './render/HiddenTiles'

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

function isFullyTransparent(rgba: Uint8ClampedArray): boolean {
  for (let i = 3; i < rgba.length; i += 4) if (rgba[i] !== 0) return false
  return true
}

/** `vram` with every char a switch in `kinds` changes swapped to its frame-0 switched pixels. */
export function switchedVram(
  animData: AnimationData,
  vram: VramState,
  kinds: ReadonlySet<SwitchKind>,
): VramState {
  return vramFromChars(vram, switchCharPixels(animData.frames[0] ?? [], kinds))
}

export function tileAlternates(
  animData: AnimationData,
  entries: readonly Map16Tile[],
  vram: VramState,
  palette: { colors: RgbaColor[] },
): Map<number, TileAlternate[]> {
  const patchedBySet = new Map<string, VramState>()
  const perTile = new Map<number, TileAlternate[]>()
  for (const tile of entries) {
    const chars = [tile.tl.charNum, tile.tr.charNum, tile.bl.charNum, tile.br.charNum]
    const kinds = [...switchesForChars(animData, chars)].sort()
    if (kinds.length === 0) continue
    const off = renderMap16Tile(tile, vram, palette)
    const offBlank = isFullyTransparent(off)
    const alternates: TileAlternate[] = []
    for (const subset of nonEmptySubsets(kinds)) {
      const key = subset.join('+')
      let patched = patchedBySet.get(key)
      if (!patched) {
        patched = switchedVram(animData, vram, new Set(subset))
        patchedBySet.set(key, patched)
      }
      const rgba = renderMap16Tile(tile, patched, palette)
      if (subset.length === 1 && Buffer.from(rgba).equals(Buffer.from(off))) continue
      alternates.push({ kinds: subset, rgba, hidden: offBlank && !isFullyTransparent(rgba) })
    }
    perTile.set(tile.id, alternates)
  }
  return perTile
}

/** Each hidden tile's picture with no switch on (`firstHiddenSingle`, the inspector's rule too). */
export function hiddenArt(alternates: Map<number, TileAlternate[]>): Map<number, TileAlternate> {
  const out = new Map<number, TileAlternate>()
  for (const [id, alts] of alternates) {
    const hidden = firstHiddenSingle(alts)
    if (hidden) out.set(id, hidden)
  }
  return out
}
