/**
 * Per-map reactive store.
 *
 * Holds ROM-derived per-level data that today is reached as `RenderContext`
 * fields populated by `SmwMap.render`. Each `SmwMap` owns one `mapStore`
 * built by `MapBuilder` from the level header - multiple maps loaded
 * simultaneously (e.g. a future level-browser thumbnail grid) get
 * independent stores.
 *
 *   - Behaviors that need per-map data receive `mapStore` as a render arg
 *     (palette is reached as `mapStore.palette`).
 *   - Tests construct minimal instances via `createMapStore({...})`.
 *
 * `reactive()` so behaviors read `mapStore.foo` directly without `.value`
 * boilerplate. Defaults are safe for the Map16 viewer's "no real map"
 * usage: `screenPipeVariantIdx: []` (PipeVariantsBehavior falls back to
 * variant 0 when the table is empty), `levelOrientation: 'horizontal'`,
 * `marioSpawnX: 0`.
 */

import { markRaw, reactive } from '@vue/reactivity'
import type { ScrollSimulator } from '../../scrollSim'
import type { Palette } from '../palette/Palette'
import type { LevelOrientation } from '../SmwMap'

export interface MapStoreState {
  /** Per-map CGRAM palette. */
  palette: Palette
  /** Level orientation - drives "scrolling axis" decisions in PipeVariantsBehavior. */
  levelOrientation: LevelOrientation
  /** Per-screen MAP16AppTable index (0..3), one per screen. PipeVariantsBehavior
   *  picks a variant via `screenPipeVariantIdx[screenOf(cell)]`. */
  screenPipeVariantIdx: readonly number[]
  /** Initial Layer1YPos in pixels - L3 tide overlays use this. */
  initialCameraYPx: number
  /** Mario's level-entry pixel X. Sprites whose ASM init uses `FaceMario`
   *  (e.g. Chargin' Chuck, Dry Bones, Super Koopa) read this to choose
   *  the toward-Mario simulation direction. */
  marioSpawnX: number
  /** Frame-accurate scroll-position simulator built from the level's
   *  scroll-sprite + parallax setup. `L2ObjectStream.render` reads
   *  `simulator.stateAtFrame(editorStore.scrollFrame)` to compute the
   *  correct (Layer1YPos − Layer2YPos) viewport delta for the current
   *  scrub position. `null` when no scroll sprite was found in the
   *  level - render falls back to the static initial offset. */
  scrollSimulator: ScrollSimulator | null
}

export type MapStore = MapStoreState

export type MapStoreInit = Partial<MapStoreState>

const DEFAULTS: MapStoreState = {
  // `palette` has no safe default - callers that don't pass one (Map16 panel)
  // construct a uniformPalette themselves. The cast lets TS allow construction
  // without it; consumers that read `palette` are responsible for ensuring
  // the field is set.
  palette: null as unknown as Palette,
  levelOrientation: 'horizontal',
  screenPipeVariantIdx: [],
  initialCameraYPx: 0,
  marioSpawnX: 0,
  scrollSimulator: null,
}

export function createMapStore(init: MapStoreInit = {}): MapStore {
  // `palette` carries a private scratch buffer that doesn't need reactive
  // wrapping (its identity changes on palette swap, not in the row()
  // hot path). markRaw keeps reactive() out of Palette internals.
  const merged: MapStoreState = { ...DEFAULTS, ...init }
  if (merged.palette) merged.palette = markRaw(merged.palette)
  // Simulator carries non-reactive caches (memoized state per frame);
  // markRaw skips reactive proxying so the per-frame mutations don't
  // trigger spurious re-renders.
  if (merged.scrollSimulator) merged.scrollSimulator = markRaw(merged.scrollSimulator)
  return reactive(merged) as MapStore
}
