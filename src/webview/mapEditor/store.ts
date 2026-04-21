/**
 * Map-editor state store (FLUX pattern, Pinia-backed).
 *
 *   View → dispatches action → store mutates state → observers re-render
 *
 * The store is the single source of truth for every reactive input into
 * either render pipeline (legacy atlas or self-rendering model). Views
 * NEVER mutate state directly — they call store actions. Readers either:
 *
 *   - Read `store.foo` (auto-unwrapped value) for one-shot reads, or
 *   - Take `storeToRefs(store).foo` (Ref<T>) when passing into the
 *     reactive render context (so @vue/reactivity tracks the `.value`
 *     access inside behaviors).
 *
 * Pinia's Setup Store is used because its refs ARE @vue/reactivity refs
 * — the same ones the model's `effect()` chain already observes. Zero
 * reactivity-runtime overhead on top of what we already have.
 */

import { createPinia, defineStore, setActivePinia } from 'pinia'
import { ref } from '@vue/reactivity'
import type {
  CameraState,
  LayerToggles,
} from '../../rom/model/RenderTarget'

// Pinia normally installs onto a Vue app; standalone webviews don't
// have one, so we activate a fresh instance at module load.
setActivePinia(createPinia())

export const useEditorStore = defineStore('editor', () => {
  // ── State ────────────────────────────────────────────────────────────
  const animFrame         = ref(0)
  const palAnimFrame      = ref(0)
  const pSwitchActive     = ref(false)
  const switchPalaceState = ref<readonly [boolean, boolean, boolean, boolean]>(
    [false, false, false, false],
  )
  const camera            = ref<CameraState>({ tileX: 0, tileY: 0, focused: false })
  /** Camera-viewport preview is visible when true. Separate from the
   *  `focused` bit on `camera` which only controls drag-to-move. */
  const cameraOn          = ref(false)
  const zoom              = ref(1)
  // Defaults match the toolbar `<input checked>` attributes — L1/L2/sprites
  // on, screens/block off. Any DOM-vs-store drift at first paint is a bug
  // in whoever wired the checkbox, not here.
  const layerToggles      = ref<LayerToggles>({
    l1: true, l2: true, sprites: true, screens: false, block: false, mapGrid: false,
  })

  // ── Actions (the only mutation sites) ────────────────────────────────
  function toggleSwitchPalace(color: 0 | 1 | 2 | 3): void {
    const s = switchPalaceState.value
    const next: [boolean, boolean, boolean, boolean] = [s[0], s[1], s[2], s[3]]
    next[color] = !next[color]
    switchPalaceState.value = next
  }

  function setSwitchPalace(color: 0 | 1 | 2 | 3, on: boolean): void {
    const s = switchPalaceState.value
    if (s[color] === on) return
    const next: [boolean, boolean, boolean, boolean] = [s[0], s[1], s[2], s[3]]
    next[color] = on
    switchPalaceState.value = next
  }

  function togglePSwitch(): void {
    pSwitchActive.value = !pSwitchActive.value
  }

  function setPSwitch(on: boolean): void {
    if (pSwitchActive.value !== on) pSwitchActive.value = on
  }

  function setAnimFrame(frame: number): void {
    if (animFrame.value !== frame) animFrame.value = frame
  }

  function setPalAnimFrame(frame: number): void {
    if (palAnimFrame.value !== frame) palAnimFrame.value = frame
  }

  function setZoom(z: number): void {
    if (zoom.value !== z) zoom.value = z
  }

  function setLayerToggle(layer: keyof LayerToggles, on: boolean): void {
    const cur = layerToggles.value
    if (cur[layer] === on) return
    layerToggles.value = { ...cur, [layer]: on }
  }

  function setLayerToggles(next: LayerToggles): void {
    const cur = layerToggles.value
    if (
      cur.l1      === next.l1      &&
      cur.l2      === next.l2      &&
      cur.sprites === next.sprites &&
      cur.screens === next.screens &&
      cur.block   === next.block
    ) return
    layerToggles.value = { ...next }
  }

  function setCamera(next: CameraState): void {
    const cur = camera.value
    if (cur.tileX === next.tileX && cur.tileY === next.tileY && cur.focused === next.focused) return
    camera.value = { ...next }
  }

  function setCameraOn(on: boolean): void {
    if (cameraOn.value !== on) cameraOn.value = on
  }

  return {
    // state
    animFrame, palAnimFrame, pSwitchActive, switchPalaceState,
    camera, cameraOn, zoom, layerToggles,
    // actions
    toggleSwitchPalace, setSwitchPalace,
    togglePSwitch,      setPSwitch,
    setAnimFrame,       setPalAnimFrame,
    setZoom,
    setLayerToggle,     setLayerToggles,
    setCamera,          setCameraOn,
  }
})

export type EditorStore = ReturnType<typeof useEditorStore>
