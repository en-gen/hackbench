/**
 * FlyingBlockBehavior — branch coverage.
 * ($83 Left Flying ? Block / $84 Flying ? Block, Flying_Block handler at
 * bank_01.asm:6171)
 *
 * Test tree:
 *   kind
 *   computePath ($83 — constant X speed $F4 = −12 signed)
 *     - returns FRAMES/SAMPLE_STEP = 60 sampled points
 *     - drifts left of spawn center
 *     - Y oscillates (yToggle clamp hit, direction reverses)
 *   computePath ($84 — accelerating X speed toward $F0 = −16)
 *     - returns 60 sampled points
 *     - overall leftward drift (post-acceleration)
 *     - xDecel lock: second half of path has greater leftward displacement
 *       than first half (xSpeedRaw hit X_CLAMP_84, xDecel set to 32)
 *     - Y oscillates
 */

import { describe, it, expect } from 'vitest'
import { FlyingBlockBehavior } from '../../../src/rom/model/sprites/behaviors/FlyingBlockBehavior'

describe('FlyingBlockBehavior — kind', () => {
  it('$83 kind === flying_block', () => {
    expect(new FlyingBlockBehavior(0x83).kind).toBe('flying_block')
  })
  it('$84 kind === flying_block', () => {
    expect(new FlyingBlockBehavior(0x84).kind).toBe('flying_block')
  })
})

describe('FlyingBlockBehavior.computePath — $83 (constant X speed $F4 = −12/frame)', () => {
  // Spawn well inside any level so the path doesn't clip to an edge.
  const beh  = new FlyingBlockBehavior(0x83)
  const path = beh.computePath(400, 120)

  it('returns 60 sampled points (FRAMES=240, SAMPLE_STEP=4)', () => {
    // CODE_01ADE8 forces XSpeed=$F4 every frame; 240/4=60 samples.
    expect(path).toHaveLength(60)
  })

  it('final position is left of spawn center', () => {
    // $F4 = −12 signed → sprite drifts left every frame.
    const spawnCenter = 400 + 8
    expect(path[path.length - 1].x).toBeLessThan(spawnCenter)
  })

  it('Y oscillates: max − min Y spread ≥ 4 px', () => {
    // DATA_01AD68[0]=$FF (−1) accumulates to Y_CLAMP[0]=$F4=−12 sub-px/frame,
    // then toggles to +1 toward Y_CLAMP[1]=$0C=+12.
    // Both Y_CLAMP branches are hit within 240 frames.
    const minY = Math.min(...path.map(p => p.y))
    const maxY = Math.max(...path.map(p => p.y))
    expect(maxY - minY).toBeGreaterThanOrEqual(4)
  })
})

describe('FlyingBlockBehavior.computePath — $84 (accelerating X speed toward $F0 = −16)', () => {
  const beh  = new FlyingBlockBehavior(0x84)
  const path = beh.computePath(400, 120)

  it('returns 60 sampled points', () => {
    expect(path).toHaveLength(60)
  })

  it('final position is left of spawn center', () => {
    // After ~64 frames the speed reaches $F0 and xDecel is set to 32;
    // with xDecel never decremented the sprite locks at full speed.
    const spawnCenter = 400 + 8
    expect(path[path.length - 1].x).toBeLessThan(spawnCenter)
  })

  it('second half of path has ≥ leftward displacement as first half (xDecel lock)', () => {
    // Frames 0–119 (samples 0–29): slow acceleration phase.
    // Frames 120–239 (samples 30–59): locked at full −16 speed.
    // Displacement in second half must be at least as large.
    const firstHalfDx  = Math.abs(path[29].x - path[0].x)
    const secondHalfDx = Math.abs(path[59].x - path[30].x)
    expect(secondHalfDx).toBeGreaterThanOrEqual(firstHalfDx)
  })

  it('Y oscillates: max − min Y spread ≥ 4 px', () => {
    const minY = Math.min(...path.map(p => p.y))
    const maxY = Math.max(...path.map(p => p.y))
    expect(maxY - minY).toBeGreaterThanOrEqual(4)
  })
})
