/**
 * editorStore actions — branch coverage.
 *
 * Every action guards with an equality check so spurious mutations don't fire
 * downstream effects. Each test exercises both:
 *   - the "no-change" path (guard short-circuits, no mutation)
 *   - the "change" path (guard passes, mutation occurs)
 *
 * Tests use createEditorStore() for full isolation.
 */

import { describe, it, expect } from 'vitest'
import { createEditorStore } from '../../../../src/rom/model/stores/editorStore'

// ── setSwitchPalace ───────────────────────────────────────────────────────────

describe('editorStore.setSwitchPalace', () => {
  it('no-change: same value → guard short-circuits', () => {
    const s = createEditorStore()
    // Default state[0] = false
    const before = s.switchPalaceState
    s.setSwitchPalace(0, false)        // same value → no mutation
    expect(s.switchPalaceState).toBe(before)
  })

  it('change: different value → state updated', () => {
    const s = createEditorStore()
    s.setSwitchPalace(2, true)
    expect(s.switchPalaceState[2]).toBe(true)
  })
})

// ── toggleSwitchPalace ────────────────────────────────────────────────────────

describe('editorStore.toggleSwitchPalace', () => {
  it('toggles false → true → false', () => {
    const s = createEditorStore()
    s.toggleSwitchPalace(1)
    expect(s.switchPalaceState[1]).toBe(true)
    s.toggleSwitchPalace(1)
    expect(s.switchPalaceState[1]).toBe(false)
  })
})

// ── setPSwitch ────────────────────────────────────────────────────────────────

describe('editorStore.setPSwitch', () => {
  it('no-change: already false → no mutation', () => {
    const s = createEditorStore()
    s.setPSwitch(false)
    expect(s.pSwitchActive).toBe(false)
  })

  it('change: false → true', () => {
    const s = createEditorStore()
    s.setPSwitch(true)
    expect(s.pSwitchActive).toBe(true)
  })
})

// ── togglePSwitch ─────────────────────────────────────────────────────────────

describe('editorStore.togglePSwitch', () => {
  it('toggles false → true', () => {
    const s = createEditorStore()
    s.togglePSwitch()
    expect(s.pSwitchActive).toBe(true)
  })
})

// ── setPalAnimFrame ───────────────────────────────────────────────────────────

describe('editorStore.setPalAnimFrame', () => {
  it('no-change: same frame → no mutation', () => {
    const s = createEditorStore()
    const before = s.palAnimFrame     // default = 1
    s.setPalAnimFrame(1)
    expect(s.palAnimFrame).toBe(before)
  })

  it('change: different frame → updated', () => {
    const s = createEditorStore()
    s.setPalAnimFrame(5)
    expect(s.palAnimFrame).toBe(5)
  })
})

// ── setZoom ───────────────────────────────────────────────────────────────────

describe('editorStore.setZoom', () => {
  it('no-change: already zoom=1 → no mutation', () => {
    const s = createEditorStore()
    s.setZoom(1)
    expect(s.zoom).toBe(1)
  })

  it('change: zoom=2 → updated', () => {
    const s = createEditorStore()
    s.setZoom(2)
    expect(s.zoom).toBe(2)
  })
})

// ── setLayerToggle ────────────────────────────────────────────────────────────

describe('editorStore.setLayerToggle', () => {
  it('no-change: l1 already true → guard short-circuits', () => {
    const s = createEditorStore()
    const before = s.layerToggles
    s.setLayerToggle('l1', true)  // default is true → no mutation
    expect(s.layerToggles).toBe(before)
  })

  it('change: l1 true → false → new object created', () => {
    const s = createEditorStore()
    const before = s.layerToggles
    s.setLayerToggle('l1', false)
    expect(s.layerToggles).not.toBe(before)
    expect(s.layerToggles.l1).toBe(false)
  })
})

// ── setLayerToggles ───────────────────────────────────────────────────────────

describe('editorStore.setLayerToggles', () => {
  it('no-change: all fields identical → guard short-circuits', () => {
    const s = createEditorStore()
    const before = s.layerToggles
    s.setLayerToggles({ ...s.layerToggles })  // structurally equal copy
    expect(s.layerToggles).toBe(before)
  })

  it('change: at least one field differs → state replaced', () => {
    const s = createEditorStore()
    const next = { ...s.layerToggles, sprites: false }
    s.setLayerToggles(next)
    expect(s.layerToggles.sprites).toBe(false)
  })
})

// ── setCamera ─────────────────────────────────────────────────────────────────

describe('editorStore.setCamera', () => {
  it('no-change: same tileX/tileY/focused → guard short-circuits', () => {
    const s = createEditorStore()
    const before = s.camera
    s.setCamera({ tileX: 0, tileY: 0, focused: false })  // defaults → no-op
    expect(s.camera).toBe(before)
  })

  it('change: different tileX → state updated', () => {
    const s = createEditorStore()
    s.setCamera({ tileX: 5, tileY: 0, focused: false })
    expect(s.camera.tileX).toBe(5)
  })
})

// ── setCameraOn ───────────────────────────────────────────────────────────────

describe('editorStore.setCameraOn', () => {
  it('no-change: already false → no mutation', () => {
    const s = createEditorStore()
    s.setCameraOn(false)
    expect(s.cameraOn).toBe(false)
  })

  it('change: false → true', () => {
    const s = createEditorStore()
    s.setCameraOn(true)
    expect(s.cameraOn).toBe(true)
  })
})

// ── setCameraDragging ─────────────────────────────────────────────────────────

describe('editorStore.setCameraDragging', () => {
  it('no-change: already false → no mutation', () => {
    const s = createEditorStore()
    s.setCameraDragging(false)
    expect(s.cameraDragging).toBe(false)
  })

  it('change: false → true', () => {
    const s = createEditorStore()
    s.setCameraDragging(true)
    expect(s.cameraDragging).toBe(true)
  })
})

// ── toggleVineSource ──────────────────────────────────────────────────────────

describe('editorStore.toggleVineSource', () => {
  it('add: key not present → added to set', () => {
    const s = createEditorStore()
    s.toggleVineSource('vine_0_5')
    expect(s.activeVineSources.has('vine_0_5')).toBe(true)
  })

  it('remove: key already present → deleted from set', () => {
    const s = createEditorStore()
    s.toggleVineSource('vine_0_5')   // add
    s.toggleVineSource('vine_0_5')   // remove
    expect(s.activeVineSources.has('vine_0_5')).toBe(false)
  })
})

// ── toggleSpriteOverlay ───────────────────────────────────────────────────────

describe('editorStore.toggleSpriteOverlay', () => {
  it('add: key not present → added', () => {
    const s = createEditorStore()
    s.toggleSpriteOverlay('spr_32_48')
    expect(s.activeSpriteOverlays.has('spr_32_48')).toBe(true)
  })

  it('remove: key present → deleted', () => {
    const s = createEditorStore()
    s.toggleSpriteOverlay('spr_32_48')
    s.toggleSpriteOverlay('spr_32_48')
    expect(s.activeSpriteOverlays.has('spr_32_48')).toBe(false)
  })
})

// ── setCursorPx ───────────────────────────────────────────────────────────────

describe('editorStore.setCursorPx', () => {
  it('pos=null, cur=null → inner guard skips mutation (cur !== null branch = false)', () => {
    const s = createEditorStore()
    // cursorPx starts null
    s.setCursorPx(null)              // !pos branch: cur===null → skip assignment
    expect(s.cursorPx).toBeNull()
  })

  it('pos=null, cur=something → clears cursorPx', () => {
    const s = createEditorStore()
    s.setCursorPx({ x: 10, y: 20 }) // set a value first
    s.setCursorPx(null)              // !pos branch: cur!==null → clears
    expect(s.cursorPx).toBeNull()
  })

  it('pos defined, cur=null → sets cursorPx (cur && ... guard = false, falls to assignment)', () => {
    const s = createEditorStore()
    s.setCursorPx({ x: 10, y: 20 })
    expect(s.cursorPx).toEqual({ x: 10, y: 20 })
  })

  it('pos same as cur → guard short-circuits (cur && same coords)', () => {
    const s = createEditorStore()
    s.setCursorPx({ x: 10, y: 20 })
    const before = s.cursorPx
    s.setCursorPx({ x: 10, y: 20 })  // same coords → no mutation
    expect(s.cursorPx).toBe(before)
  })

  it('pos different from cur → updates cursorPx', () => {
    const s = createEditorStore()
    s.setCursorPx({ x: 10, y: 20 })
    s.setCursorPx({ x: 30, y: 40 })
    expect(s.cursorPx).toEqual({ x: 30, y: 40 })
  })
})

// ── setL2YOverride ────────────────────────────────────────────────────────────

describe('editorStore.setL2YOverride', () => {
  it('y=null → stores null (null ternary branch)', () => {
    const s = createEditorStore()
    s.setL2YOverride(null)
    expect(s.l2YOverride).toBeNull()
  })

  it('y=100 → stores clamped value (non-null ternary branch)', () => {
    const s = createEditorStore()
    s.setL2YOverride(100)
    expect(s.l2YOverride).toBe(100)
  })

  it('no-change: same value twice → second call is no-op', () => {
    const s = createEditorStore()
    s.setL2YOverride(50)
    const before = s.l2YOverride
    s.setL2YOverride(50)             // same → no mutation
    expect(s.l2YOverride).toBe(before)
  })

  it('null → 0: l2YOverride changes from null to 0', () => {
    const s = createEditorStore()
    // starts null
    s.setL2YOverride(0)
    expect(s.l2YOverride).toBe(0)
  })
})

// ── setScrollProgress ─────────────────────────────────────────────────────────

describe('editorStore.setScrollProgress', () => {
  it('no-change: already 0 → no mutation', () => {
    const s = createEditorStore()
    s.setScrollProgress(0)
    expect(s.scrollProgress).toBe(0)
  })

  it('change: 0 → 128', () => {
    const s = createEditorStore()
    s.setScrollProgress(128)
    expect(s.scrollProgress).toBe(128)
  })
})

// ── setScrollPlaybackFrame ────────────────────────────────────────────────────

describe('editorStore.setScrollPlaybackFrame', () => {
  it('no-change: already -1 (default) → no mutation', () => {
    const s = createEditorStore()
    s.setScrollPlaybackFrame(-1)
    expect(s.scrollPlaybackFrame).toBe(-1)
  })

  it('change: -1 → 10', () => {
    const s = createEditorStore()
    s.setScrollPlaybackFrame(10)
    expect(s.scrollPlaybackFrame).toBe(10)
  })
})
