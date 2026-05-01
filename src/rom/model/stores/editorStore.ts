/**
 * Editor-singleton reactive store.
 *
 * Holds editor/UI/animation/cursor state that is global to the running editor
 * (not per-map). Built on plain `@vue/reactivity` `reactive()` so the model
 * layer stays Pinia-free and the existing `effect()`/`computed()` graph picks
 * up dependencies the same way it did with `Ref<T>` reads.
 *
 *   - Behaviors that read editor state import `editorStore` directly.
 *   - Webview reads/mutates via the same singleton (re-exported from
 *     `src/webview/mapEditor/store.ts`).
 *   - Tests construct independent instances via `createEditorStore()`.
 *
 * Mutation goes through actions only. Each action guards with an equality
 * check so spurious mutations don't fire downstream effects.
 */

import { reactive } from '@vue/reactivity'
import type { CameraState, LayerToggles } from '../RenderTarget'

interface EditorStoreState {
  palAnimFrame: number
  pSwitchActive: boolean
  switchPalaceState: readonly [boolean, boolean, boolean, boolean]
  camera: CameraState
  cameraOn: boolean
  cameraDragging: boolean
  zoom: number
  layerToggles: LayerToggles
  activeVineSources: ReadonlySet<string>
  activeSpriteOverlays: ReadonlySet<string>
  cursorPx: { x: number; y: number } | null
}

interface EditorStoreActions {
  toggleSwitchPalace(color: 0 | 1 | 2 | 3): void
  setSwitchPalace(color: 0 | 1 | 2 | 3, on: boolean): void
  togglePSwitch(): void
  setPSwitch(on: boolean): void
  setPalAnimFrame(frame: number): void
  setZoom(z: number): void
  setLayerToggle(layer: keyof LayerToggles, on: boolean): void
  setLayerToggles(next: LayerToggles): void
  setCamera(next: CameraState): void
  setCameraOn(on: boolean): void
  setCameraDragging(on: boolean): void
  toggleVineSource(key: string): void
  toggleSpriteOverlay(key: string): void
  setCursorPx(pos: { x: number; y: number } | null): void
}

export type EditorStore = EditorStoreState & EditorStoreActions

export function createEditorStore(): EditorStore {
  const s = reactive<EditorStoreState>({
    palAnimFrame: 1,
    pSwitchActive: false,
    switchPalaceState: [false, false, false, false],
    camera: { tileX: 0, tileY: 0, focused: false },
    cameraOn: false,
    cameraDragging: false,
    zoom: 1,
    layerToggles: {
      l1: true, l2: true, l3: true, sprites: true, screens: false,
      block: false, mapGrid: false, l3Hud: false, surfaces: false,
      walls: false, l3Range: false,
    },
    activeVineSources: new Set(),
    activeSpriteOverlays: new Set(),
    cursorPx: null,
  })

  const actions: EditorStoreActions = {
    toggleSwitchPalace(color) {
      const cur = s.switchPalaceState
      const next: [boolean, boolean, boolean, boolean] = [cur[0], cur[1], cur[2], cur[3]]
      next[color] = !next[color]
      s.switchPalaceState = next
    },
    setSwitchPalace(color, on) {
      const cur = s.switchPalaceState
      if (cur[color] === on) return
      const next: [boolean, boolean, boolean, boolean] = [cur[0], cur[1], cur[2], cur[3]]
      next[color] = on
      s.switchPalaceState = next
    },
    togglePSwitch() {
      s.pSwitchActive = !s.pSwitchActive
    },
    setPSwitch(on) {
      if (s.pSwitchActive !== on) s.pSwitchActive = on
    },
    setPalAnimFrame(frame) {
      if (s.palAnimFrame !== frame) s.palAnimFrame = frame
    },
    setZoom(z) {
      if (s.zoom !== z) s.zoom = z
    },
    setLayerToggle(layer, on) {
      const cur = s.layerToggles
      if (cur[layer] === on) return
      s.layerToggles = { ...cur, [layer]: on }
    },
    setLayerToggles(next) {
      const cur = s.layerToggles
      if (
        cur.l1       === next.l1       &&
        cur.l2       === next.l2       &&
        cur.l3       === next.l3       &&
        cur.sprites  === next.sprites  &&
        cur.screens  === next.screens  &&
        cur.block    === next.block    &&
        cur.mapGrid  === next.mapGrid  &&
        cur.l3Hud    === next.l3Hud    &&
        cur.surfaces === next.surfaces &&
        cur.walls    === next.walls    &&
        cur.l3Range  === next.l3Range
      ) return
      s.layerToggles = { ...next }
    },
    setCamera(next) {
      const cur = s.camera
      if (cur.tileX === next.tileX && cur.tileY === next.tileY && cur.focused === next.focused) return
      s.camera = { ...next }
    },
    setCameraOn(on) {
      if (s.cameraOn !== on) s.cameraOn = on
    },
    setCameraDragging(on) {
      if (s.cameraDragging !== on) s.cameraDragging = on
    },
    toggleVineSource(key) {
      const next = new Set(s.activeVineSources)
      if (next.has(key)) next.delete(key); else next.add(key)
      s.activeVineSources = next
    },
    toggleSpriteOverlay(key) {
      const next = new Set(s.activeSpriteOverlays)
      if (next.has(key)) next.delete(key); else next.add(key)
      s.activeSpriteOverlays = next
    },
    setCursorPx(pos) {
      const cur = s.cursorPx
      if (!pos) { if (cur !== null) s.cursorPx = null; return }
      const nx = Math.round(pos.x), ny = Math.round(pos.y)
      if (cur && cur.x === nx && cur.y === ny) return
      s.cursorPx = { x: nx, y: ny }
    },
  }

  return Object.assign(s, actions) as EditorStore
}

export const editorStore: EditorStore = createEditorStore()
