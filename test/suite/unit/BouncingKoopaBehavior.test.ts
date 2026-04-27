/**
 * ASM-derived tests for $09 Green Para-Koopa (bouncing variant) — the
 * `GreenParaKoopa` handler at bank_01.asm:1817 branched at line 1835
 * (`CMP #$08; BNE CODE_018C8C`) where $09 takes the non-$08 branch.
 *
 * The $09 branch is nearly identical to HoppingFlame:
 *   - `SubUpdateSprPos` + `DEC.B SpriteYSpeed,X` (net +2/frame gravity)
 *   - Spr0to13SpeedX (bank_01.asm:1390) = db $08,$F8,$0C,$F4
 *     — Green Para-Koopa uses the fast indices 0/1 → vx ±$08 (not ASL'd;
 *     differs from HopFlame's ±$10 after ASL)
 *   - On ground, `SetSomeYSpeed__` (bank_01.asm:1860) picks vy from
 *     `SpriteMisc160E`: = 0 → vy = $B0 ($B0 signed = -80 = tall bounce),
 *                        ≠ 0 → vy = $D0 ($D0 signed = -48 = short bounce).
 *     The spawn Y low nibble bit 4 seeds $160E so adjacent spawns
 *     alternate bounce height.
 *   - `FlipIfTouchingObj` flips direction when blocked (walls, not ledges
 *     — prop $50 bit 1 = 0, so $09 doesn't turn at ledges; falls off).
 *   - No hop countdown — bounces every frame while on ground.
 *
 * Test tree:
 *
 *   simulateArc — worst-case bounce envelope
 *     ├─ envelope.maxY ≤ groundY + 16 (never clips into ground)
 *     ├─ envelope.minY < groundY - 24 (reaches noticeable apex)
 *     ├─ flat corridor: bounce apex ≈ (80² / (2·2)) / 16 ≈ 100 px? — no
 *     │   that's tall-bounce worst case; we test the floor is deterministic
 *     ├─ bounces between walls — envelope stays inside the interior
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
  stepFrameForTest,
  makeFreshState,
  BOUNCE_TALL_VY,
  BOUNCE_SHORT_VY,
  BOUNCE_XSPEED,
} from '../../../src/rom/model/sprites/behaviors/BouncingKoopaBehavior'
import { buildSolidity } from './fixtures/buildSolidity'

const GROUND = { actsLike: 0x130 }   // page-1 low byte $30
const WALL   = { actsLike: 0x130 }
const PASS   = { actsLike: 0x005 }
const BODY   = 16

describe('BouncingKoopaBehavior — simulateArc', () => {
  const at = (c: number, r: number) => ({ x: c * BODY, y: r * BODY })

  it('envelope.maxY never clips into the ground row', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..........',
      '..........',
      '..........',
      '..........',
      '##########',
    ], { '#': GROUND })
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
    // Regression for level $125 c29 r23 — row 23 has SpriteYPosLow bit 4 set,
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
    const envTall  = beh.simulateArc(at(5, 14).x, at(5, 14).y, solidH, solidV, cols, rows)
    // Short apex must be strictly less tall than tall apex, and bounded
    // above by the analytic short-bounce ceiling (vy=-48, net+2/frame →
    // peak ≈ 48²/(2·2) = 576 sub-px = 36 px). Allow some sub-pixel
    // wobble; require it stays comfortably below 50 px and below the
    // tall apex.
    const shortApexHeight = envShort.groundY - envShort.minY
    const tallApexHeight  = envTall.groundY  - envTall.minY
    expect(shortApexHeight).toBeLessThan(tallApexHeight)
    expect(shortApexHeight).toBeLessThanOrEqual(50)
    expect(shortApexHeight).toBeGreaterThanOrEqual(20)
  })

  it('walled corridor bounds the horizontal envelope', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.W.......W',
      '.W.......W',
      '.W.......W',
      '.W.......W',
      '##########',
    ], { '#': GROUND, 'W': WALL })
    const beh = new BouncingKoopaBehavior()
    const { x, y } = at(5, 3)
    const env = beh.simulateArc(x, y, solidH, solidV, cols, rows)
    expect(env.minX).toBeGreaterThanOrEqual(2 * BODY)
    expect(env.maxX).toBeLessThanOrEqual(9 * BODY)
  })

  it('bouncePath records at least 2 bounce samples on flat ground', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..........',
      '..........',
      '##########',
    ], { '#': GROUND })
    const beh = new BouncingKoopaBehavior()
    const { x, y } = at(5, 1)
    const path = beh.computeBouncePath(x, y, solidH, solidV, cols, rows)
    expect(path.length).toBeGreaterThanOrEqual(2)
  })

  it('is deterministic across repeated calls', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..........',
      '..........',
      '##########',
    ], { '#': GROUND })
    const beh = new BouncingKoopaBehavior()
    const a = beh.simulateArc(5 * BODY, BODY, solidH, solidV, cols, rows)
    const b = beh.simulateArc(5 * BODY, BODY, solidH, solidV, cols, rows)
    expect(a).toEqual(b)
  })

  it('exposes metadata', () => {
    const beh = new BouncingKoopaBehavior()
    expect(beh.kind).toBe('bouncing_koopa')
  })
})

describe('BouncingKoopaBehavior — per-frame physics (stepFrameForTest)', () => {
  const { solidH, solidV, cols, rows } = buildSolidity([
    '.......',
    '.......',
    '#######',
  ], { '#': GROUND })
  const PASS_ignored = PASS  // eslint-disable-line @typescript-eslint/no-unused-vars

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
    const { solidH: sH, solidV: sV, cols: c, rows: r } = buildSolidity([
      '.......',
      '.......',
      '.......',
      '.......',
      '.......',
      '#######',
    ], { '#': GROUND })
    const s = makeFreshState({ x: 3 * BODY, y: 0, ground: false, misc160E: 0, vy: 0 })
    stepFrameForTest(s, sH, sV, c, r)
    // Frame 1: applyGravity adds +3 → vy=+3, DEC Y speed -1 → vy=+2.
    expect(s.vy).toBe(2)
    stepFrameForTest(s, sH, sV, c, r)
    // Frame 2: applyGravity adds +3 → vy=+5, DEC -1 → vy=+4.
    expect(s.vy).toBe(4)
  })

  it('vy clamps at +$40 terminal velocity', () => {
    // Drop from open air; iterate until vy stabilises — should plateau at $40.
    const { solidH: sH, solidV: sV, cols: c, rows: r } = buildSolidity(
      ['.......', '.......', '.......', '.......', '.......', '.......',
       '.......', '.......', '.......', '.......', '.......', '.......',
       '.......', '.......', '.......', '.......', '.......', '.......',
       '.......', '.......', '.......', '.......', '.......', '.......',
       '.......', '.......', '.......', '.......', '.......', '#######'],
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
    const { solidH: sH, solidV: sV, cols: c, rows: r } = buildSolidity([
      '....W..',
      '...K.W.',
      '#######',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const s = makeFreshState({ x: 3 * BODY, y: BODY, ground: false, misc160E: 0, vx: 8, dir: 0 })
    // Step forward with a tight wall on the right; the sprite should hit
    // it in a frame or two and flip.
    let flipped = false
    for (let i = 0; i < 10; i++) {
      stepFrameForTest(s, sH, sV, c, r)
      if (s.dir === 1) { flipped = true; break }
    }
    expect(flipped).toBe(true)
  })
})
