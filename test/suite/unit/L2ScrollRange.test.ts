/**
 * Unit tests for L2 scroll-sprite scan and scroll-range derivation (#246).
 *
 * Pure functions — no ROM dependency. computeL2ScrollRange is the L2 sibling
 * of computeL3ScrollRange (L3Loader.ts:574).
 *
 * Note on naming: the cmd value returned by `findLevelScrollSprite` is the
 * **Layer1ScrollCmd** (bank_02.asm:5290-5300 writes `spriteId - $E7` there,
 * NOT to Layer2ScrollCmd). Layer2ScrollCmd stays 0 in normal gameplay; every
 * write to it lives in bank_0C cutscene/credits code.
 */

import { describe, it, expect } from 'vitest'
import {
  computeL2ScrollRange,
  findLevelScrollSprite,
  SCROLL_SPRITE_BASE,
  type L2ScrollRangeInput,
} from '../../../src/rom/L2Loader'
import type { LevelSprite } from '../../../src/rom/LevelParser'

function sprite(spriteId: number): LevelSprite {
  return { screen: 0, x: 0, y: 0, spriteId, extraBit: false, raw: [0, 0, spriteId] }
}

describe('findLevelScrollSprite', () => {
  it('returns null for empty sprite list', () => {
    expect(findLevelScrollSprite([])).toBe(null)
  })

  it('returns null when no sprite id reaches the scroll-sprite base', () => {
    expect(findLevelScrollSprite([sprite(0x00), sprite(0x80), sprite(0xE6)])).toBe(null)
  })

  it('returns Layer1ScrollCmd index (spriteId - $E7) for a scroll sprite', () => {
    // $E8 → cmd 01 (matches level $009 in vanilla SMW — auto-scroller).
    expect(findLevelScrollSprite([sprite(0xE8)])).toBe(0x01)
    // $F5 → cmd $0E (matches levels $1E2/$1EC/$1EF — Layer 2 sink/rise).
    expect(findLevelScrollSprite([sprite(0xF5)])).toBe(0x0E)
  })

  it('first scroll sprite wins (bank_02.asm:5294 short-circuits via BNE +)', () => {
    // The sprite stream may contain multiple scroll sprites; only the first
    // one to spawn writes Layer1ScrollCmd because subsequent invocations hit
    // the `LDA Layer1ScrollCmd / ORA Layer2ScrollCmd / BNE +` guard.
    const cmd = findLevelScrollSprite([sprite(0x10), sprite(0xE8), sprite(0xF5)])
    expect(cmd).toBe(0x01)
  })

  it('SCROLL_SPRITE_BASE is $E7', () => {
    expect(SCROLL_SPRITE_BASE).toBe(0xE7)
  })
})

describe('computeL2ScrollRange', () => {
  const baseInput: Omit<L2ScrollRangeInput, 'grid' | 'layer1ScrollCmd'> = {
    initialLayer2YPx: 0xC0,
    initialCameraYPx: 0xC0,
    levelPixelW:      256 * 8,
  }

  it('kind: none for an empty grid (no cells)', () => {
    const grid: (number | null)[][] = Array.from({ length: 27 }, () =>
      new Array<number | null>(32).fill(null),
    )
    const r = computeL2ScrollRange({ ...baseInput, grid, layer1ScrollCmd: null })
    expect(r.kind).toBe('none')
  })

  it('kind: fixed when grid has data and no scroll sprite is found', () => {
    const grid: (number | null)[][] = Array.from({ length: 27 }, () =>
      new Array<number | null>(32).fill(null),
    )
    grid[5][3] = 0x100
    grid[10][4] = 0x100
    const r = computeL2ScrollRange({ ...baseInput, grid, layer1ScrollCmd: null })
    expect(r.kind).toBe('fixed')
    // dy = -0xC0 + 0xC0 = 0 here, so yMin/yMax are exactly the data row band.
    expect(r.yMin).toBe(5 * 16)
    expect(r.yMax).toBe((10 + 1) * 16)
    expect(r.xMin).toBe(0)
    expect(r.xMax).toBe(baseInput.levelPixelW)
    expect(r.layer1ScrollCmd).toBeUndefined()
  })

  it('records Layer1ScrollCmd diagnostically when a scroll sprite is present', () => {
    const grid: (number | null)[][] = Array.from({ length: 27 }, () =>
      new Array<number | null>(32).fill(null),
    )
    grid[8][1] = 0x100
    const r = computeL2ScrollRange({ ...baseInput, grid, layer1ScrollCmd: 0x0E })
    // Still 'fixed' kind today — gameplay-L2 has no per-frame Y animation
    // we've decoded yet. The cmd is just a diagnostic label.
    expect(r.kind).toBe('fixed')
    expect(r.layer1ScrollCmd).toBe(0x0E)
  })

  it('applies dy = initialCameraYPx - initialLayer2YPx to grid bounds', () => {
    const grid: (number | null)[][] = Array.from({ length: 27 }, () =>
      new Array<number | null>(32).fill(null),
    )
    grid[5][0] = 0x100
    const r = computeL2ScrollRange({
      ...baseInput,
      initialLayer2YPx: 0xC0,
      initialCameraYPx: 0x40,  // dy = 0x40 - 0xC0 = -0x80
      grid,
      layer1ScrollCmd: null,
    })
    expect(r.kind).toBe('fixed')
    expect(r.yMin).toBe(5 * 16 - 0x80)
    expect(r.yMax).toBe((5 + 1) * 16 - 0x80)
  })
})
