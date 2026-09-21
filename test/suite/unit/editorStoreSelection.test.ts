/**
 * editorStore - selected-sprite state.
 *
 * The level canvas is drawn by a @vue/reactivity effect, so the selection
 * has to live on the store for the mark to appear and disappear without
 * an explicit redraw call. These tests lock that it is reactive and that
 * it clears.
 */

import { describe, expect, it } from 'vitest'
import { effect } from '@vue/reactivity'
import { createEditorStore } from '../../../src/rom/model/stores/editorStore'

describe('editorStore selectedSpriteKey', () => {
  it('starts with nothing selected', () => {
    expect(createEditorStore().selectedSpriteKey).toBeNull()
  })

  it('holds the key it was given', () => {
    const s = createEditorStore()
    s.setSelectedSprite('15:32,48')
    expect(s.selectedSpriteKey).toBe('15:32,48')
  })

  it('clears back to null', () => {
    const s = createEditorStore()
    s.setSelectedSprite('15:32,48')
    s.setSelectedSprite(null)
    expect(s.selectedSpriteKey).toBeNull()
  })

  it('re-runs a reactive effect on select and on clear', () => {
    const s = createEditorStore()
    const seen: (string | null)[] = []
    effect(() => {
      seen.push(s.selectedSpriteKey)
    })
    s.setSelectedSprite('15:32,48')
    s.setSelectedSprite(null)
    expect(seen).toEqual([null, '15:32,48', null])
  })

  it('does not re-run when the same key is set again', () => {
    const s = createEditorStore()
    let runs = 0
    effect(() => {
      void s.selectedSpriteKey
      runs++
    })
    s.setSelectedSprite('15:32,48')
    s.setSelectedSprite('15:32,48')
    expect(runs).toBe(2)
  })
})
