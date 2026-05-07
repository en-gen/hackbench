/**
 * ASM-derived tests for $27 Thwimp — handler at bank_01.asm:6464–6510.
 *
 * Test tree:
 *
 *   computeBouncePath  (first hop only — leftward)
 *     direction
 *       └─ arc ends to the left of spawn (C2: 0→1 odd → carry set → $F0 leftward)
 *     dual gravity
 *       ├─ ascending gravity +3 → apex ≥ 80 px above ground
 *       └─ arc terminates (descending gravity +5 brings sprite back down)
 *     terminal velocity
 *       └─ path length < 512 frames
 *     ground snap
 *       └─ airborne spawn snaps to first solid row before launching
 *     ceiling
 *       └─ ceiling mid-arc cuts apex smaller than open-sky arc
 *     level edge
 *       └─ near left boundary — arc clips without crash or NaN
 *     no-floor
 *       └─ level with no solid floor returns valid path without throwing
 */

import { describe, expect, it } from 'vitest'
import { ThwimpBounceBehavior } from '../../../src/rom/model/sprites/behaviors/ThwimpBounceBehavior'
import { buildSolidity } from './fixtures/buildSolidity'

const GROUND = { actsLike: 0x130 }   // page-1 $30 — canonical solid floor/wall
const CEIL   = { actsLike: 0x130 }
const BODY   = 16

describe('ThwimpBounceBehavior.computeBouncePath', () => {
  describe('direction (bank_01.asm:6493–6502)', () => {
    it('first hop launches leftward — C2: 0→1 odd → carry set → BCC not taken → vx=$F0 (−16)', () => {
      // ASM: bank_01.asm:6493 — INC SpriteTableC2 → C2=1 (odd). LSR shifts bit 0
      // into carry (carry=1). BCC not taken → LDA #$F0 executes → vx=−16 (leftward).
      const { solidV, cols, rows } = buildSolidity([
        '.................................',
        '.................................',
        '.................................',
        '#################################',
      ], { '#': GROUND })
      const beh = new ThwimpBounceBehavior()
      const path = beh.computeBouncePath(16 * BODY, 2 * BODY, solidV, cols, rows)
      expect(path.length).toBeGreaterThan(0)
      const spawnCenter = 16 * BODY + BODY / 2
      // Arc goes left: the minimum x reached must be to the left of spawn.
      expect(Math.min(...path.map(p => p.x))).toBeLessThan(spawnCenter)
      // And the final landing point must also be to the left.
      expect(path[path.length - 1].x).toBeLessThan(spawnCenter)
    })
  })

  describe('dual gravity (bank_01.asm:6467–6479)', () => {
    it('apex is ≥ 80 px above ground — consistent with ascending gravity +3', () => {
      // ASM: bank_01.asm:6467 — BPL CODE_01AFC8; ADC #$03 (ascending gravity)
      // With GRAV_UP=3, apex ≈ 99 px above ground.
      // With GRAV_UP=5 (wrong), apex ≈ 58 px — this test would fail.
      const { solidV, cols, rows } = buildSolidity([
        '.........................',
        '.........................',
        '.........................',
        '.........................',
        '.........................',
        '.........................',
        '.........................',
        '.........................',
        '#########################',
      ], { '#': GROUND })
      const beh = new ThwimpBounceBehavior()
      const groundTop = 8 * BODY   // row 8 top = 128
      const path = beh.computeBouncePath(12 * BODY, 7 * BODY, solidV, cols, rows)
      // path[*].y is body-bottom; apex = min y across the arc.
      // Resting body-bottom = groundTop = 128. With GRAV_UP=3, apex ≈ 29 (128 − 99).
      expect(Math.min(...path.map(p => p.y))).toBeLessThanOrEqual(groundTop - 80)
    })

    it('arc terminates — descending gravity +5 brings sprite back to ground', () => {
      // ASM: bank_01.asm:6473 — ADC #$05 (descending gravity, faster than ascending)
      const { solidV, cols, rows } = buildSolidity([
        '.........................',
        '.........................',
        '.........................',
        '#########################',
      ], { '#': GROUND })
      const beh = new ThwimpBounceBehavior()
      const path = beh.computeBouncePath(12 * BODY, 2 * BODY, solidV, cols, rows)
      expect(path.length).toBeGreaterThan(2)
      expect(path.length).toBeLessThan(512)
    })
  })

  describe('terminal velocity (bank_01.asm:6476 — BCS CODE_01AFC8)', () => {
    it('path stays finite even with no ceiling', () => {
      // Without terminal-velocity clamping, vy grows unboundedly and the
      // sprite would exit the level without landing — sim would hit the 512 guard.
      const { solidV, cols, rows } = buildSolidity([
        '................',
        '................',
        '................',
        '................',
        '................',
        '################',
      ], { '#': GROUND })
      const beh = new ThwimpBounceBehavior()
      const path = beh.computeBouncePath(8 * BODY, 4 * BODY, solidV, cols, rows)
      expect(path.length).toBeLessThan(512)
    })
  })

  describe('ground snap (bank_01.asm:6323 — Return01AEA2: RTS, no anchor shift)', () => {
    it('airborne spawn snaps to the first solid row below before launching', () => {
      // Thwimp init routine is RTS only — simulator must snap to ground.
      const { solidV, cols, rows } = buildSolidity([
        '.............',
        '.............',   // spawn row (mid-air)
        '.............',
        '.............',
        '#############',   // actual ground at row 4
      ], { '#': GROUND })
      const beh = new ThwimpBounceBehavior()
      const path = beh.computeBouncePath(6 * BODY, 1 * BODY, solidV, cols, rows)
      const groundRowTop = 4 * BODY   // 64 px
      // All path body-bottoms must not exceed ground row top.
      for (const p of path) {
        expect(p.y).toBeLessThanOrEqual(groundRowTop + 0.5)
      }
    })
  })

  describe('ceiling (bank_01.asm:6480–6485 — IsTouchingCeiling → vy=$10)', () => {
    it('ceiling mid-arc cuts the apex to a shallower height than open sky', () => {
      // ASM: bank_01.asm:6480 — JSR IsTouchingCeiling; BEQ +; LDA #$10; STA SpriteYSpeed,X
      const openRows = [
        '...........',
        '...........',
        '...........',
        '...........',
        '...........',
        '...........',
        '...........',
        '###########',
      ]
      const ceilRows = [
        '###########',   // low ceiling at row 0
        '...........',
        '...........',
        '###########',   // floor at row 3
      ]
      const open = buildSolidity(openRows, { '#': GROUND })
      const ceil = buildSolidity(ceilRows, { '#': CEIL })
      const beh  = new ThwimpBounceBehavior()

      const pathOpen = beh.computeBouncePath(5 * BODY, 6 * BODY, open.solidV, open.cols, open.rows)
      const pathCeil = beh.computeBouncePath(5 * BODY, 2 * BODY, ceil.solidV, ceil.cols, ceil.rows)

      const apexOpen = Math.min(...pathOpen.map(p => p.y))
      const apexCeil = Math.min(...pathCeil.map(p => p.y))
      // Ceiling-constrained arc must have a larger minY (= shallower apex).
      expect(apexCeil).toBeGreaterThan(apexOpen)
    })
  })

  describe('level-edge clip', () => {
    it('near left boundary — left-going arc clips without crash or NaN', () => {
      // First hop is leftward; placing Thwimp near the left edge exercises
      // the level-edge guard in moveX.
      const { solidV, cols, rows } = buildSolidity([
        '............',
        '............',
        '############',
      ], { '#': GROUND })
      const beh = new ThwimpBounceBehavior()
      const path = beh.computeBouncePath(1 * BODY, 1 * BODY, solidV, cols, rows)
      for (const p of path) {
        expect(Number.isFinite(p.x)).toBe(true)
        expect(Number.isFinite(p.y)).toBe(true)
        expect(p.x).toBeGreaterThanOrEqual(0)
      }
    })

    it('spawnX=0 — moveX edge guard fires immediately on frame 1 (nextX < 0 TRUE branch)', () => {
      // Thwimp at x=0. First hop: vx=-16 → wholeDelta=-1 → stepX=-1 → nextX=-1.
      // `nextX < 0` is TRUE → the level-edge break in moveX fires on the very
      // first pixel step. Thwimp stays at x=0 for this frame, then lands.
      // This covers the `nextX < 0 || nextX + BODY_W > levelCols * 16` TRUE branch.
      const { solidV, cols, rows } = buildSolidity([
        '............',
        '............',
        '############',
      ], { '#': GROUND })
      const beh = new ThwimpBounceBehavior()
      const path = beh.computeBouncePath(0, 1 * BODY, solidV, cols, rows)
      // Path should contain entries, all with x >= 0 (never went negative)
      expect(path.length).toBeGreaterThan(0)
      for (const p of path) {
        expect(p.x).toBeGreaterThanOrEqual(0)
        expect(Number.isFinite(p.x)).toBe(true)
      }
    })
  })

  describe('no-floor degenerate case', () => {
    it('level with no solid floor returns a valid path without throwing', () => {
      // Sim terminates after 512 frames; path may be short but must not throw.
      const { solidV, cols, rows } = buildSolidity([
        '.........',
        '.........',
        '.........',
      ], {})
      const beh = new ThwimpBounceBehavior()
      const path = beh.computeBouncePath(4 * BODY, 1 * BODY, solidV, cols, rows)
      expect(Array.isArray(path)).toBe(true)
      for (const p of path) {
        expect(Number.isFinite(p.x)).toBe(true)
        expect(Number.isFinite(p.y)).toBe(true)
      }
    })
  })
})
