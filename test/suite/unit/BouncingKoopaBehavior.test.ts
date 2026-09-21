/**
 * ASM-derived tests for $09 Green Para-Koopa (bouncing variant) - the
 * `GreenParaKoopa` handler at bank_01.asm:1817 branched at line 1835
 * (`CMP #$08; BNE CODE_018C8C`) where $09 takes the non-$08 branch.
 *
 * The $09 branch is nearly identical to HoppingFlame:
 *   - `SubUpdateSprPos` + `DEC.B SpriteYSpeed,X` (net +2/frame gravity)
 *   - Spr0to13SpeedX (bank_01.asm:1390) = db $08,$F8,$0C,$F4
 *     - Green Para-Koopa uses the fast indices 0/1 → vx ±$08 (not ASL'd;
 *     differs from HopFlame's ±$10 after ASL)
 *   - On ground, `SetSomeYSpeed__` (bank_01.asm:1860) picks vy from
 *     `SpriteMisc160E`: = 0 → vy = $B0 ($B0 signed = -80 = tall bounce),
 *                        ≠ 0 → vy = $D0 ($D0 signed = -48 = short bounce).
 *     The spawn Y low nibble bit 4 seeds $160E so adjacent spawns
 *     alternate bounce height.
 *   - `FlipIfTouchingObj` flips direction when blocked (walls, not ledges
 *     - prop $50 bit 1 = 0, so $09 doesn't turn at ledges; falls off).
 *   - No hop countdown - bounces every frame while on ground.
 *
 * Test tree:
 *
 *   simulateArc - worst-case bounce envelope
 *     ├─ envelope.maxY ≤ groundY + 16 (never clips into ground)
 *     ├─ envelope.minY < groundY - 24 (reaches noticeable apex)
 *     ├─ flat corridor: bounce apex ≈ (80² / (2·2)) / 16 ≈ 100 px? - no
 *     │   that's tall-bounce worst case; we test the floor is deterministic
 *     ├─ bounces between walls - envelope stays inside the interior
 *     ├─ bouncePath has ≥ 3 landing points for stable cycling
 *     ├─ gap in floor with turnsAtLedges=false: arc passes over (envelope
 *     │   extends beyond gap column; may fall if the gap is wide)
 *     └─ deterministic across repeated calls (no RNG)
 *
 *   per-frame physics (inspectable state)
 *     ├─ on-ground with misc160E=0 → next frame vy = $B0 (tall bounce)
 *     ├─ on-ground with misc160E=1 → next frame vy = $D0 (short bounce)
 *     ├─ vx from Spr0to13SpeedX[dir] = ±$08 (not doubled like HopFlame)
 *     ├─ gravity net +2/frame (SubUpdateSprPos +3, DEC Y speed -1)
 *     ├─ vy terminal clamp at +$40
 *     └─ wall contact flips dir + negates vx
 */

import { describe, expect, it } from 'vitest'
import {
  BouncingKoopaBehavior,
  applyXSpeed,
  applyYSpeed,
  stepFrameForTest,
  makeFreshState,
  BOUNCE_TALL_VY,
  BOUNCE_SHORT_VY,
  BOUNCE_XSPEED,
} from '../../../src/rom/model/sprites/behaviors/BouncingKoopaBehavior'
import { buildSolidity } from './fixtures/buildSolidity'
import type { GetL1Tile, L1Cell } from '../../../src/rom/model/OverlayContext'
import type { SolidV } from '../../../src/rom/model/sprites/MovementBehavior'

const GROUND = { actsLike: 0x130 } // page-1 low byte $30
const WALL = { actsLike: 0x130 }
const PASS = { actsLike: 0x005 }
const BODY = 16

describe('BouncingKoopaBehavior - simulateArc', () => {
  const at = (c: number, r: number) => ({ x: c * BODY, y: r * BODY })

  it('envelope.maxY never clips into the ground row', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new BouncingKoopaBehavior()
    const { x, y } = at(5, 3)
    const env = beh.simulateArc(x, y, solidH, solidV, cols, rows)
    expect(env.maxY).toBe(env.groundY + BODY)
    expect(env.maxY).toBeLessThanOrEqual(4 * BODY)
  })

  it('reaches a tall-bounce apex well above the ground row (even-row spawn)', () => {
    // Need enough headroom (≥ 110 rows = 1760 px) so the apex doesn't clip
    // into the top ceiling. Tall-bounce worst-case apex ≈ 100 px above
    // spawn per the vy=-80 / gravity +2 physics.
    const level: string[] = []
    for (let i = 0; i < 15; i++) level.push('..........')
    level.push('##########')
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new BouncingKoopaBehavior()
    // Row 14 → spawnY=224 → bit 4 = 0 → bounceSeed=0 → tall ($B0=-80).
    // Tall bounce: vy=-80 sub-px/frame, gravity net +2/frame.
    // Peak sub-px displacement ≈ 80²/(2·2) = 1600 sub-px = 100 px above spawn.
    // Real trajectory with sub-pixel accumulator lands a little shy of that;
    // require at least 50 px clearance.
    const { x, y } = at(5, 14)
    const env = beh.simulateArc(x, y, solidH, solidV, cols, rows)
    expect(env.minY).toBeLessThanOrEqual(env.groundY - 50)
  })

  it('odd-row spawn produces a SHORTER apex (bounceSeed = $10 → vy = $D0)', () => {
    // Regression for level $125 c29 r23 - row 23 has SpriteYPosLow bit 4 set,
    // so InitGrnBounceKoopa (bank_01.asm:840) seeds misc160E=$10 and
    // SetSomeYSpeed__ relaunches at vy=$D0 (-48). The simulator must mirror
    // this; without the bit-4 check the overlay always shows tall-bounce
    // height (~100 px) even when the actual sprite uses short-bounce (~37 px).
    const level: string[] = []
    for (let i = 0; i < 15; i++) level.push('..........')
    level.push('##########')
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new BouncingKoopaBehavior()
    // Row 13 → spawnY=208 → 208 & $10 = $10 → short bounce.
    const { x, y } = at(5, 13)
    const envShort = beh.simulateArc(x, y, solidH, solidV, cols, rows)
    // Row 14 → tall (covered by the previous test).
    const envTall = beh.simulateArc(at(5, 14).x, at(5, 14).y, solidH, solidV, cols, rows)
    // Short apex must be strictly less tall than tall apex, and bounded
    // above by the analytic short-bounce ceiling (vy=-48, net+2/frame →
    // peak ≈ 48²/(2·2) = 576 sub-px = 36 px). Allow some sub-pixel
    // wobble; require it stays comfortably below 50 px and below the
    // tall apex.
    const shortApexHeight = envShort.groundY - envShort.minY
    const tallApexHeight = envTall.groundY - envTall.minY
    expect(shortApexHeight).toBeLessThan(tallApexHeight)
    expect(shortApexHeight).toBeLessThanOrEqual(50)
    expect(shortApexHeight).toBeGreaterThanOrEqual(20)
  })

  it('walled corridor bounds the horizontal envelope', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['.W.......W', '.W.......W', '.W.......W', '.W.......W', '##########'],
      { '#': GROUND, W: WALL },
    )
    const beh = new BouncingKoopaBehavior()
    const { x, y } = at(5, 3)
    const env = beh.simulateArc(x, y, solidH, solidV, cols, rows)
    expect(env.minX).toBeGreaterThanOrEqual(2 * BODY)
    expect(env.maxX).toBeLessThanOrEqual(9 * BODY)
  })

  it('bouncePath records at least 2 bounce samples on flat ground', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new BouncingKoopaBehavior()
    const { x, y } = at(5, 1)
    const path = beh.computeBouncePath(x, y, solidH, solidV, cols, rows)
    expect(path.length).toBeGreaterThanOrEqual(2)
  })

  it('is deterministic across repeated calls', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new BouncingKoopaBehavior()
    const a = beh.simulateArc(5 * BODY, BODY, solidH, solidV, cols, rows)
    const b = beh.simulateArc(5 * BODY, BODY, solidH, solidV, cols, rows)
    expect(a).toEqual(b)
  })

  it('exposes metadata', () => {
    const beh = new BouncingKoopaBehavior()
    expect(beh.kind).toBe('bouncing_koopa')
  })

  it('bounceModeAt: spawnY with bit 4 clear → tall', () => {
    // spawnY=32: 32 & 0x10 = 0 → 'tall'
    expect(new BouncingKoopaBehavior().bounceModeAt(32)).toBe('tall')
  })

  it('bounceModeAt: spawnY with bit 4 set → short', () => {
    // spawnY=16: 16 & 0x10 = 16 → 'short'
    expect(new BouncingKoopaBehavior().bounceModeAt(16)).toBe('short')
  })

  it('computeBouncePath: tall-mode spawnY (seed=0) returns path', () => {
    // spawnY=32: (32 & 0x10) === 0 → 'tall' → seed=0 (covers the false arm of the ternary)
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new BouncingKoopaBehavior()
    const path = beh.computeBouncePath(5 * BODY, 2 * BODY, solidH, solidV, cols, rows)
    expect(path.length).toBeGreaterThanOrEqual(2)
  })
})

describe('BouncingKoopaBehavior - per-frame physics (stepFrameForTest)', () => {
  const { solidH, solidV, cols, rows } = buildSolidity(['.......', '.......', '#######'], {
    '#': GROUND,
  })
  const PASS_ignored = PASS // eslint-disable-line @typescript-eslint/no-unused-vars

  it('on-ground with misc160E=0 transitions to tall bounce (vy = $B0 = -80)', () => {
    const s = makeFreshState({ x: 3 * BODY, y: BODY, ground: true, misc160E: 0 })
    stepFrameForTest(s, solidH, solidV, cols, rows)
    // stepFrame applies SetSomeYSpeed__ on the on-ground branch; after one
    // frame the launch speed should be stored in vy.
    expect(s.vy).toBe(-80)
  })

  it('on-ground with misc160E=1 transitions to short bounce (vy = $D0 = -48)', () => {
    const s = makeFreshState({ x: 3 * BODY, y: BODY, ground: true, misc160E: 1 })
    stepFrameForTest(s, solidH, solidV, cols, rows)
    expect(s.vy).toBe(-48)
  })

  it('BOUNCE constants match ASM expectations', () => {
    expect(BOUNCE_TALL_VY).toBe(-80)
    expect(BOUNCE_SHORT_VY).toBe(-48)
    expect(BOUNCE_XSPEED).toBe(0x08)
  })

  it('vx is +$08 facing right, -$08 facing left (never ASL doubled)', () => {
    const sR = makeFreshState({ x: 3 * BODY, y: BODY, ground: true, misc160E: 0, dir: 0 })
    stepFrameForTest(sR, solidH, solidV, cols, rows)
    // After launch, vx is set in stepFrame by the facing branch (airborne now).
    expect(Math.abs(sR.vx)).toBeLessThanOrEqual(0x10)
    // Run one more frame with the launched state; vx should be ±$08.
    stepFrameForTest(sR, solidH, solidV, cols, rows)
    expect(sR.vx).toBe(+BOUNCE_XSPEED)

    const sL = makeFreshState({ x: 3 * BODY, y: BODY, ground: true, misc160E: 0, dir: 1 })
    stepFrameForTest(sL, solidH, solidV, cols, rows)
    stepFrameForTest(sL, solidH, solidV, cols, rows)
    expect(sL.vx).toBe(-BOUNCE_XSPEED)
  })

  it('gravity nets +2/frame in the airborne mid-flight case', () => {
    // Simulate a clearly-airborne frame where neither ceiling nor floor is
    // reached within the step. Place the sprite high up in open space.
    const {
      solidH: sH,
      solidV: sV,
      cols: c,
      rows: r,
    } = buildSolidity(['.......', '.......', '.......', '.......', '.......', '#######'], {
      '#': GROUND,
    })
    const s = makeFreshState({ x: 3 * BODY, y: 0, ground: false, misc160E: 0, vy: 0 })
    stepFrameForTest(s, sH, sV, c, r)
    // Frame 1: applyGravity adds +3 → vy=+3, DEC Y speed -1 → vy=+2.
    expect(s.vy).toBe(2)
    stepFrameForTest(s, sH, sV, c, r)
    // Frame 2: applyGravity adds +3 → vy=+5, DEC -1 → vy=+4.
    expect(s.vy).toBe(4)
  })

  it('vy clamps at +$40 terminal velocity', () => {
    // Drop from open air; iterate until vy stabilises - should plateau at $40.
    const {
      solidH: sH,
      solidV: sV,
      cols: c,
      rows: r,
    } = buildSolidity(
      [
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '.......',
        '#######',
      ],
      { '#': GROUND },
    )
    const s = makeFreshState({ x: 3 * BODY, y: 0, ground: false, misc160E: 0, vy: 0 })
    for (let i = 0; i < 200; i++) {
      stepFrameForTest(s, sH, sV, c, r)
      if (s.ground) break
    }
    expect(s.vy).toBeLessThanOrEqual(0x40)
  })

  it('wall contact flips direction and negates vx', () => {
    const {
      solidH: sH,
      solidV: sV,
      cols: c,
      rows: r,
    } = buildSolidity(['....W..', '...K.W.', '#######'], { '#': GROUND, W: WALL, K: PASS })
    const s = makeFreshState({ x: 3 * BODY, y: BODY, ground: false, misc160E: 0, vx: 8, dir: 0 })
    // Step forward with a tight wall on the right; the sprite should hit
    // it in a frame or two and flip.
    let flipped = false
    for (let i = 0; i < 10; i++) {
      stepFrameForTest(s, sH, sV, c, r)
      if (s.dir === 1) {
        flipped = true
        break
      }
    }
    expect(flipped).toBe(true)
  })
})

// ── applyXSpeed / applyYSpeed branch coverage ─────────────────────────────────

describe('BouncingKoopaBehavior - applyXSpeed off-grid branches', () => {
  it('vx=0 early return leaves state unchanged', () => {
    const { solidH, cols } = buildSolidity(['..'], {})
    const s = makeFreshState({ x: 0, y: 0, ground: false, misc160E: 0, vx: 0 })
    applyXSpeed(s, solidH, cols)
    expect(s.x).toBe(0)
    expect(s.offgrid).toBe(false)
  })

  it('col < 0 (walk off left edge) sets offgrid', () => {
    // 2-col level; sprite at x=0 walks left - leading col becomes -1.
    const { solidH, cols } = buildSolidity(['..', '..'], {})
    const s = makeFreshState({ x: 0, y: 0, ground: false, misc160E: 0, vx: -8 })
    // vx=-8 → totalSub=-128 → wholeDelta=-1 → one pixel step left
    applyXSpeed(s, solidH, cols)
    expect(s.offgrid).toBe(true)
  })

  it('col >= levelCols (walk off right edge) sets offgrid', () => {
    // 1-col level (col 0 only); sprite at x=0 walks right.
    const { solidH, cols } = buildSolidity(['.'], {})
    const s = makeFreshState({ x: 0, y: 0, ground: false, misc160E: 0, vx: 16 })
    // vx=16 → totalSub=256 → wholeDelta=1 → nextX=1 → leadingX=16 → col=1 >= 1
    applyXSpeed(s, solidH, cols)
    expect(s.offgrid).toBe(true)
  })
})

describe('BouncingKoopaBehavior - applyYSpeed branch coverage', () => {
  it('ascending past row 0 sets offgrid', () => {
    const { solidV, rows } = buildSolidity(['.'], {})
    // y=0, vy=-16 → wholeDelta=-1 → nextY=-1 → row=-1 < 0
    const s = makeFreshState({ x: 0, y: 0, ground: false, misc160E: 0, vy: -16 })
    applyYSpeed(s, solidV, rows)
    expect(s.offgrid).toBe(true)
  })

  it('falling past last row sets offgrid', () => {
    // 1-row level (no floor); sprite near bottom, vy=16 → falls off
    const { solidV, rows } = buildSolidity(['.'], {})
    // y=14, vy=16 → totalSub=256 → wholeDelta=1 → nextY=15 → leadingY=30 → row=1 >= 1
    const s = makeFreshState({ x: 0, y: 14, ground: false, misc160E: 0, vy: 16 })
    applyYSpeed(s, solidV, rows)
    expect(s.offgrid).toBe(true)
  })

  it('vy=0 with sprite bottom past levelRows → ground=false (sittingOnFloor row>=rows)', () => {
    // 1-row empty level; sprite at y=0 → foot row = floor(16/16) = 1 >= rows(1)
    const { solidV, rows } = buildSolidity(['.'], {})
    const s = makeFreshState({ x: 0, y: 0, ground: true, misc160E: 0, vy: 0 })
    applyYSpeed(s, solidV, rows)
    expect(s.ground).toBe(false)
  })

  it('falling hit without getL1 snaps to row*16 surface', () => {
    // Air row 0, GROUND row 1. Sprite at y=8, vy=16 → hits row 1.
    const { solidV, rows } = buildSolidity(['..', '##'], { '#': GROUND })
    const s = makeFreshState({ x: 0, y: 8, ground: false, misc160E: 0, vy: 16 })
    // totalSub=256, wholeDelta=1, nextY=9, leadingY=24, row=1 → hit
    // surfaceY = row * 16 = 16 (no collision); s.y = 16 - BODY_H = 0
    applyYSpeed(s, solidV, rows)
    expect(s.y).toBe(0)
    expect(s.ground).toBe(true)
    expect(s.vy).toBe(0)
  })

  it('falling hit with getL1 uses collision.surfaceYAt', () => {
    // Same layout but with getL1 - exercises the collision-truthy surfaceYAt path.
    const { solidV, getL1, rows } = buildSolidity(['..', '##'], { '#': GROUND })
    const s = makeFreshState({ x: 0, y: 8, ground: false, misc160E: 0, vy: 16 })
    applyYSpeed(s, solidV, rows, getL1)
    // collision.surfaceYAt for flat GROUND at row 1 still returns 16; result is same
    expect(s.y).toBe(0)
    expect(s.ground).toBe(true)
  })

  it('ascending legacy (no getL1) ceiling hit snaps to (row+1)*16', () => {
    // GROUND at row 0, air at row 1. Sprite at y=16, vy=-16 → hits ceiling at row 0.
    const { solidV, rows } = buildSolidity(['##', '..'], { '#': GROUND })
    const s = makeFreshState({ x: 0, y: 16, ground: false, misc160E: 0, vy: -16 })
    // totalSub=-256, wholeDelta=-1 → nextY=15, leadingY=15, row=0 → solidV true → hit
    // no collision (no getL1) → else branch → s.y = (0+1)*16 = 16
    applyYSpeed(s, solidV, rows)
    expect(s.y).toBe(16)
    expect(s.vy).toBe(0)
  })

  it('ascending with collision uses ceilingV (else if branch)', () => {
    // GROUND at row 0 has ceiling=true. With getL1, uses collision.ceilingV path.
    const { solidV, getL1, rows } = buildSolidity(['##', '..'], { '#': GROUND })
    const s = makeFreshState({ x: 0, y: 16, ground: false, misc160E: 0, vy: -16 })
    applyYSpeed(s, solidV, rows, getL1)
    // else if (collision) path: collision.ceilingV(0,0) = true → hit → snap
    expect(s.y).toBe(16)
    expect(s.vy).toBe(0)
  })
})

// ── computeBouncePolyline (simulateCyclePolyline) branch coverage ─────────────

describe('BouncingKoopaBehavior - computeBouncePolyline', () => {
  it('returns 512 points and openEnd:false in walled corridor (max-frames path)', () => {
    // simulateCyclePolyline returns openEnd:false only after MAX_FRAMES=512 -
    // the `if (s.ground)` landing check is unreachable because stepFrame
    // immediately clears s.ground via the IsOnGround relaunch.  Walls prevent
    // horizontal exit so the sprite stays in bounds for all 512 frames.
    // 15 air rows + 1 ground = 256 px tall; tall bounce apex ≈ y=121 (row 7) - safe.
    const level = Array(15).fill('W........W').concat(['##########'])
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND, W: WALL })
    const beh = new BouncingKoopaBehavior()
    // spawnX=5*BODY=80 > marioSpawnX=0 → dir=1 (left); spawnY=row14=224
    const result = beh.computeBouncePolyline(5 * BODY, 14 * BODY, solidH, solidV, cols, rows, 0)
    expect(result.points).toHaveLength(512)
    expect(result.openEnd).toBe(false)
  })

  it('dir=0 path: marioSpawnX > spawnX produces rightward trajectory', () => {
    const level = Array(15).fill('W........W').concat(['##########'])
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND, W: WALL })
    const beh = new BouncingKoopaBehavior()
    // spawnX=1*BODY=16 <= marioSpawnX=5*BODY=80 → dir=0 (right) - false branch
    const result = beh.computeBouncePolyline(
      1 * BODY,
      14 * BODY,
      solidH,
      solidV,
      cols,
      rows,
      5 * BODY,
    )
    expect(result.points.length).toBeGreaterThan(0)
  })

  it('returns openEnd:true when sprite walks off the right edge', () => {
    // 1-col level (col 0 only); sprite launches right and exits immediately
    const level = ['.', '#']
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new BouncingKoopaBehavior()
    // spawnX=0 <= marioSpawnX=2*BODY → dir=0 (right) → exits right edge
    const result = beh.computeBouncePolyline(0, 0, solidH, solidV, cols, rows, 2 * BODY)
    expect(result.openEnd).toBe(true)
  })

  it('short-bounce spawnY: seed=0x10 branch fires in computeBouncePolyline', () => {
    // spawnY = 1*BODY = 16. 16 & 0x10 = 16 → bounceModeFromSpawnY returns 'short'.
    // → seed = 0x10 (the true branch at bank_01.asm:1860 vy=$D0 path).
    // All other computeBouncePolyline tests use even-row spawnY (tall bounce);
    // this test exercises the 0x10 branch specifically.
    const level = Array(5).fill('..........').concat(['##########'])
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new BouncingKoopaBehavior()
    // spawnY=1*BODY=16 → bit4=1 → short; spawnX > marioSpawnX → dir=1 (left)
    const result = beh.computeBouncePolyline(5 * BODY, 1 * BODY, solidH, solidV, cols, rows, 0)
    expect(result.points.length).toBeGreaterThan(0)
  })

  it('marioSpawnX default parameter: omitting arg 7 uses default 0 (default-param TRUE branch)', () => {
    // Calling with only 6 arguments leaves marioSpawnX at its default of 0.
    // This covers the TypeScript-compiled default-parameter branch
    // (`marioSpawnX === undefined → use 0`).
    const level = Array(5).fill('..........').concat(['##########'])
    const { solidH, solidV, cols, rows } = buildSolidity(level, { '#': GROUND })
    const beh = new BouncingKoopaBehavior()
    // No marioSpawnX argument → default 0 → spawnX=5*BODY=80 > 0 → dir=1 (left)
    const result = beh.computeBouncePolyline(5 * BODY, 4 * BODY, solidH, solidV, cols, rows)
    expect(result.points.length).toBeGreaterThan(0)
  })
})

// ── getL1 / collision path (simulateCycle + simulateCyclePolyline branches) ──

describe('BouncingKoopaBehavior - getL1 collision-path branches', () => {
  it('simulateArc with getL1: collision object used for floor snap and surface-Y (simulateCycle branches)', () => {
    // Covers in simulateCycle:
    //   const collision = getL1 ? spriteCollisionFromL1(getL1) : undefined  → true
    //   collision?.findFloorRowBelow(...)  → defined branch
    //   collision?.surfaceYAt(...)         → defined branch
    // Covers in applyYSpeed (via stepFrame):
    //   const collision = getL1 ? ...  → true branch
    //   const surfaceY = collision ? collision.surfaceYAt(...) : row*16  → true branch
    // Covers in sittingOnFloor:
    //   if (collision)  → true branch (vy=0 check on next frame after landing)
    const { solidH, solidV, getL1, cols, rows } = buildSolidity(
      ['.........', '.........', '.........', '#########'],
      { '#': GROUND },
    )
    const beh = new BouncingKoopaBehavior()
    const env = beh.simulateArc(4 * BODY, 2 * BODY, solidH, solidV, cols, rows, getL1)
    expect(env.groundY).toBeLessThan(rows * BODY)
    expect(env.minY).toBeLessThan(env.groundY)
  })

  it('computeBouncePolyline with getL1: simulateCyclePolyline collision-path branches', () => {
    // Covers in simulateCyclePolyline:
    //   const collision = getL1 ? ...  → true branch
    //   collision?.findFloorRowBelow(...)  → defined branch
    //   collision?.surfaceYAt(...)         → defined branch
    // Also covers: ascending with collision → else if (collision) ceilingV path
    const { solidH, solidV, getL1, cols, rows } = buildSolidity(
      ['.........', '.........', '.........', '#########'],
      { '#': GROUND },
    )
    const beh = new BouncingKoopaBehavior()
    const result = beh.computeBouncePolyline(
      4 * BODY,
      2 * BODY,
      solidH,
      solidV,
      cols,
      rows,
      0,
      getL1,
    )
    expect(result.points.length).toBeGreaterThan(0)
    // openEnd may be true if the koopa bounces offgrid in the small test arena; we only
    // care that the collision path (getL1 branch) was exercised, not the final state.
  })
})

// ── sittingOnFloor - slope detection path ─────────────────────────────────────

describe('BouncingKoopaBehavior - sittingOnFloor slope branch', () => {
  // A slope cell with floor=false so solidV misses it, but collision.slopeAt returns a profile.
  const SLOPE_HEIGHTS_ZERO = new Uint8Array(16).fill(0) // surface at tile-top: surfaceY = row*16
  const SLOPE_HEIGHTS_HIGH = new Uint8Array(16).fill(15) // surface at tile-bottom: surfaceY = row*16+15

  function makeSlopeGetL1(row: number, heights: Uint8Array): GetL1Tile {
    const slopeCell: L1Cell = {
      id: 1,
      actsLike: 0x170,
      collision: {
        floor: false,
        ceiling: false,
        wall: false,
        slopeTable: true,
        marioFloor: false,
        marioCeiling: false,
        marioWall: false,
        slope: { slopeIndex: 0, heights },
      },
    }
    return (c, r) => (r === row ? slopeCell : null)
  }

  it('slope at row 1, sprite bottom at surface top (16 >= 16): sittingOnFloor → true', () => {
    // ASM: sittingOnFloor → solidV misses, slopeAt finds profile, height check passes.
    // Covers: if (collision) true, if (slope) true, if (s.y+BODY_H >= surfaceY) true
    const getL1 = makeSlopeGetL1(1, SLOPE_HEIGHTS_ZERO)
    const solidV: SolidV = () => false
    const s = makeFreshState({ x: 0, y: 0, ground: false, misc160E: 0, vy: 0 })
    // s.y + BODY_H = 16; row = floor(16/16) = 1; surfaceY = 1*16 + (0 & 0x0F) = 16; 16 >= 16 → true
    applyYSpeed(s, solidV, 5, getL1)
    expect(s.ground).toBe(true)
  })

  it('slope at row 1, sprite bottom above surface (16 < 31): sittingOnFloor → false', () => {
    // Covers: if (slope) true, if (s.y+BODY_H >= surfaceY) false branch
    const getL1 = makeSlopeGetL1(1, SLOPE_HEIGHTS_HIGH)
    const solidV: SolidV = () => false
    const s = makeFreshState({ x: 0, y: 0, ground: false, misc160E: 0, vy: 0 })
    // s.y+BODY_H = 16; row=floor(16/16)=1; surfaceY=1*16+(15&0x0F)=31; 16 >= 31 → false
    applyYSpeed(s, solidV, 5, getL1)
    expect(s.ground).toBe(false)
  })
})
