/**
 * StaticQuadBehavior — always returns the same quad reference.
 *
 * The simplest tile behavior: wraps a fixed SubtileQuad and returns it
 * unchanged every frame, regardless of editor / map state. Used for
 * all non-special Map16 tiles after TileFactory's dispatch.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { computed } from '@vue/reactivity'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import { StaticQuadBehavior } from '../../../../src/rom/model/tiles/behaviors/StaticQuadBehavior'
import { editorStore, resetEditorStore } from '../fixtures/stores'

function makeQuad(): SubtileQuad {
  const sub = () => new SubTile(new Char(0, new StaticPixelsBehavior(new Uint8Array(64))), 0, false, false, false)
  return [sub(), sub(), sub(), sub()]
}

describe('StaticQuadBehavior', () => {
  beforeEach(resetEditorStore)

  it('selectQuad returns the exact quad reference passed to the constructor', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    expect(b.selectQuad()).toBe(quad)
  })

  it('returns the same reference on every call', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    const q1 = b.selectQuad()
    const q2 = b.selectQuad()
    expect(q1).toBe(q2)
  })

  it('is invariant when pSwitchActive changes', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    editorStore.setPSwitch(true)
    expect(b.selectQuad()).toBe(quad)
  })

  it('is invariant when switchPalaceState changes', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    editorStore.setSwitchPalace(0, true)
    editorStore.setSwitchPalace(1, true)
    editorStore.setSwitchPalace(2, true)
    editorStore.setSwitchPalace(3, true)
    expect(b.selectQuad()).toBe(quad)
  })

  it('computed() wrapping selectQuad is never re-evaluated on store changes (no reactive reads)', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    let evaluations = 0
    const reactive = computed(() => {
      evaluations++
      return b.selectQuad()
    })

    expect(reactive.value).toBe(quad)
    expect(evaluations).toBe(1)

    // Mutating any editorStore field should NOT cause a recompute because
    // StaticQuadBehavior reads nothing — the computed stays warm.
    editorStore.setPSwitch(true)
    editorStore.setPalAnimFrame(3)
    expect(reactive.value).toBe(quad)
    expect(evaluations).toBe(1)
  })

  it('stores the quad on the .quad property', () => {
    const quad = makeQuad()
    const b = new StaticQuadBehavior(quad)
    expect(b.quad).toBe(quad)
  })
})
