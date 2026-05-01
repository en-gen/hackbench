/**
 * StarOneUpVineBlockBehavior — column-dispatch tests.
 *
 * Ports CODE_00F1AE (bank_00.asm:12868) via DATA_00F080[$09]=$81
 * (column-cycle, second-half offset) and DATA_00F100[16..31]:
 *
 *   (col % 16) % 3 === 0  →  sprite $76 (star)
 *   (col % 16) % 3 === 1  →  sprite $78 (1-up mushroom)
 *   (col % 16) % 3 === 2  →  sprite $79 (vine)
 *
 * TouchBlockXPos (direct page $9A) is the low byte of the block's
 * pixel X, so the lookup wraps every 16 tiles = 1 screen.
 */

import { describe, it, expect, beforeEach } from 'vitest'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SubTile } from '../../../../src/rom/model/tiles/SubTile'
import { type SubtileQuad } from '../../../../src/rom/model/tiles/Tile'
import {
  starOneUpVineItemAt,
  StarOneUpVineBlockBehavior,
} from '../../../../src/rom/model/tiles/behaviors/StarOneUpVineBlockBehavior'
import { editorStore, resetEditorStore } from '../fixtures/stores'

function makeChar(): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64)))
}

function makeSub(): SubTile {
  return new SubTile(makeChar(), 0, false, false, false)
}

function makeQuad(): SubtileQuad {
  return [makeSub(), makeSub(), makeSub(), makeSub()]
}

describe('starOneUpVineItemAt — column dispatch (CODE_00F1AE)', () => {
  // (col % 16) % 3 === 0 → star ($76)
  it.each([0, 3, 6, 9, 12, 15])('col %i → star', (col) => {
    expect(starOneUpVineItemAt(col)).toBe('star')
  })

  // (col % 16) % 3 === 1 → 1up ($78)
  it.each([1, 4, 7, 10, 13])('col %i → 1up', (col) => {
    expect(starOneUpVineItemAt(col)).toBe('1up')
  })

  // (col % 16) % 3 === 2 → vine ($79)
  it.each([2, 5, 8, 11, 14])('col %i → vine', (col) => {
    expect(starOneUpVineItemAt(col)).toBe('vine')
  })

  it('col 16 wraps to same result as col 0 (star)', () => {
    expect(starOneUpVineItemAt(16)).toBe(starOneUpVineItemAt(0))
    expect(starOneUpVineItemAt(16)).toBe('star')
  })

  it('col 17 wraps to same result as col 1 (1up)', () => {
    expect(starOneUpVineItemAt(17)).toBe(starOneUpVineItemAt(1))
    expect(starOneUpVineItemAt(17)).toBe('1up')
  })

  it('col 18 wraps to same result as col 2 (vine)', () => {
    expect(starOneUpVineItemAt(18)).toBe(starOneUpVineItemAt(2))
    expect(starOneUpVineItemAt(18)).toBe('vine')
  })

  it('col 32 wraps to star (two full screens)', () => {
    expect(starOneUpVineItemAt(32)).toBe('star')
  })

  it('col 33 wraps to 1up', () => {
    expect(starOneUpVineItemAt(33)).toBe('1up')
  })
})

describe('StarOneUpVineBlockBehavior', () => {
  beforeEach(resetEditorStore)

  it('selectQuad returns the stored quad reference unchanged', () => {
    const quad = makeQuad()
    const b = new StarOneUpVineBlockBehavior(quad, null, [], [])
    expect(b.selectQuad()).toBe(quad)
  })

  it('selectQuad is invariant across animFrame changes', () => {
    const quad = makeQuad()
    const b = new StarOneUpVineBlockBehavior(quad, null, [], [])
    const q1 = b.selectQuad()
    editorStore.setAnimFrame(99)
    const q2 = b.selectQuad()
    expect(q1).toBe(q2)
  })

  it('itemAtCol matches starOneUpVineItemAt for all positions 0–18', () => {
    const b = new StarOneUpVineBlockBehavior(makeQuad(), null, [], [])
    for (let col = 0; col <= 18; col++) {
      expect(b.itemAtCol(col)).toBe(starOneUpVineItemAt(col))
    }
  })
})
