/**
 * Shared store fixtures for unit tests.
 *
 * Tests historically built ad-hoc `RenderContext` literals via per-file
 * `mockCtx()` helpers; the new architecture splits that into:
 *   - `editorStore`  (singleton, mutated via actions)
 *   - `mapStore`     (per-map, ROM-derived data)
 *
 * Tests can either:
 *   (a) Mutate the shared `editorStore` directly via its actions and
 *       assert resulting render output. Wrap in `resetEditorStore()` if
 *       isolation matters.
 *   (b) Build a minimal `mapStore` with `makeTestMapStore({...})` for
 *       behaviors that read mapStore fields (palette, screen pipe variants,
 *       mario spawn X, etc.).
 *
 * Pinia is gone; the editor store is plain `@vue/reactivity`, so tests can
 * just import `editorStore` and call its actions to set state. There's no
 * cross-test bleed risk *as long as tests reset*; provide a helper for that.
 */

import { editorStore } from '../../../../src/rom/model/stores/editorStore'
import {
  createMapStore,
  type MapStore,
  type MapStoreInit,
} from '../../../../src/rom/model/stores/mapStore'

/** Reset the shared editor store to its construction defaults. */
export function resetEditorStore(): void {
  editorStore.setPalAnimFrame(1)
  editorStore.setPSwitch(false)
  editorStore.setSwitchPalace(0, false)
  editorStore.setSwitchPalace(1, false)
  editorStore.setSwitchPalace(2, false)
  editorStore.setSwitchPalace(3, false)
  editorStore.setCamera({ tileX: 0, tileY: 0, focused: false })
  editorStore.setCameraOn(false)
  editorStore.setCameraDragging(false)
  editorStore.setZoom(1)
  editorStore.setLayerToggles({
    l1: true, l2: true, l3: true, sprites: true, screens: false,
    block: false, mapGrid: false, l3Hud: false, surfaces: false,
    walls: false, l3Range: false, l2Range: false,
  })
  editorStore.setCursorPx(null)
}

export function makeTestMapStore(init: MapStoreInit = {}): MapStore {
  return createMapStore(init)
}

export { editorStore }
