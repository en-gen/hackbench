/**
 * ASM-derived tests for ground-walking koopas ($04/$05/$06/$07/$0C, + family
 * handlers Goomba $0F / Buzzy Beetle $11 / Spiny $13) — the `Spr0to13Main`
 * handler at bank_01.asm:1659–1747, wall check `CODE_01928E` at 2613, floor
 * check `CODE_01933B` at 2705, ledge-turn check `SpriteInAir` at 1718.
 *
 * Spr0to13Prop (bank_01.asm:1393) bits we care about for overlay:
 *   bit 1 = 1 → stay on ledges (turnsAtLedges=true)
 *   bit 6 = 1 → tall 2-tile body (affects which L1 rows the wall check scans)
 *   bit 0 = fast-slope speed modifier; not relevant to overlay geometry
 *
 * Vanilla Spr0to13Prop values:
 *   $04 = $40 → bit 1=0, bit 6=1 → turnsAtLedges=false, tall=true
 *   $05 = $42 → bit 1=1, bit 6=1 → turnsAtLedges=true,  tall=true
 *   $06 = $43 → bit 1=1, bit 6=1 → turnsAtLedges=true,  tall=true
 *   $07 = $45 → bit 1=0, bit 6=1 → turnsAtLedges=false, tall=true
 *   $0C = $5C → bit 1=0, bit 6=1 → turnsAtLedges=false, tall=true
 *   $0F = $20 → bit 1=0, bit 6=0 → turnsAtLedges=false, tall=false (Goomba)
 *
 * Test tree:
 *
 *   propsFromSpriteId (factory helper) — bit extraction
 *     ├─ $04/$05/$06/$07/$0C produce expected (turnsAtLedges, tall) tuples
 *     └─ $0F Goomba: tall=false (one-row body)
 *
 *   computePatrolRange — corridor bounds from L1 acts-like grid
 *     ├─ empty level: leftX=0, rightX=levelCols*16
 *     ├─ wall at col+3 to right: rightX = 3*16 = 48 px from spawn column
 *     ├─ wall at col-2 to left : leftX = (sprCol-2+1)*16
 *     ├─ spawn column never self-blocks even if a wall tile sits there
 *     ├─ acts-like $10 body-row tile: not a wall (doesn't stop scan)
 *     ├─ acts-like $11 body-row tile: wall (stops scan)
 *     ├─ acts-like $6D body-row tile: wall (upper inclusive)
 *     ├─ acts-like $6E body-row tile: not a wall (slope exclusive)
 *     ├─ priority-1 body-row tile (filtered by buildSolidity): not a wall
 *     ├─ turnsAtLedges=true  + gap in floor: stops at first floor-missing column
 *     ├─ turnsAtLedges=false + gap in floor: walks past (only walls stop)
 *     ├─ tall=true  + wall only in top body row: wall blocks
 *     ├─ tall=true  + wall only in bot body row: wall blocks
 *     ├─ tall=false + top-row wall (1-row body): ignored (scans bot row only)
 *     └─ level edge: scan terminates at col=0 / col=cols
 *
 *   integration-ish
 *     ├─ 5-col corridor with walls at both ends: patrol covers interior
 *     └─ dynamic-behavior tile (non-StaticQuad) with wall acts-like: blocks
 */

import { describe, expect, it } from 'vitest'
import {
  KoopaWalkBehavior,
  propsFromSpriteId,
  type KoopaWalkConfig,
} from '../../../src/rom/model/sprites/behaviors/KoopaWalkBehavior'
import { buildSolidity } from './fixtures/buildSolidity'

// Page-1 actsLike values — only page-1+ tiles register as walls per the
// vanilla SMW convention (see `isActsLikeHorizSolid` in OverlayContext).
// Page-0 tiles are decorative / slope / animated-foreground and are
// never L1 walls, even when their low byte would land in $11-$6D.
const GROUND = { actsLike: 0x130 }
const WALL   = { actsLike: 0x130 }
const SLOPE  = { actsLike: 0x06E }           // page-0 slope (vanilla convention)
const PASS   = { actsLike: 0x005 }           // page-0 passthrough (dragon-coin range)
const GRASS  = { actsLike: 0x025, priority: true }
const WALL_11 = { actsLike: 0x111 }
const WALL_6D = { actsLike: 0x16D }

describe('KoopaWalkBehavior.propsFromSpriteId', () => {
  it.each<[number, KoopaWalkConfig]>([
    [0x04, { turnsAtLedges: false, tall: true,  walkSpeed: 0x0C }],
    [0x05, { turnsAtLedges: true,  tall: true,  walkSpeed: 0x0C }],
    [0x06, { turnsAtLedges: true,  tall: true,  walkSpeed: 0x0C }],
    [0x07, { turnsAtLedges: false, tall: true,  walkSpeed: 0x0C }],
    [0x0C, { turnsAtLedges: false, tall: true,  walkSpeed: 0x0C }],
    [0x0F, { turnsAtLedges: false, tall: false, walkSpeed: 0x08 }],  // Goomba — bit 6 clear, fast
  ])('spriteId $%s produces expected config', (id, expected) => {
    expect(propsFromSpriteId(id)).toEqual(expected)
  })

  it('unknown id returns a safe fallback (non-turning, tall, slow)', () => {
    expect(propsFromSpriteId(0xFF)).toEqual({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
  })
})

describe('KoopaWalkBehavior.computePatrolRange — wall scan', () => {
  // The overlay visualises LEFTWARD patrol only — koopas spawn facing
  // LEFT and this is the direction shown. Right scan is clipped to the
  // sprite's right edge, so all wall/slope/acts-like tests place their
  // probe tiles LEFT of the spawn column.
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  it('empty corridor, turnsAtLedges=true: scans both directions, both reach level edge', () => {
    // Ledge-turning koopas ($05/$06) patrol between BOTH boundaries;
    // both sides get scanned. In an empty corridor, neither direction
    // hits an obstacle, so both sides land on the level edge.
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.........',
      '....K....',
      '#########',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftX).toBe(0)
    expect(r.rightX).toBe(cols * 16)
    expect(r.leftKind).toBe('levelEdge')
    expect(r.rightKind).toBe('levelEdge')
  })

  it('empty corridor, turnsAtLedges=false: right clamps to sprite edge', () => {
    // Non-turning koopas ($04/$07/$0C) walk left only — right scan is
    // skipped and rightX clamps to the sprite's right edge.
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.........',
      '....K....',
      '#########',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.rightX).toBe(5 * 16)
    expect(r.rightKind).toBe('levelEdge')
  })

  it('wall at col-3 to the left: leftX = (col+1)*16 = 32', () => {
    //    r0: . . W . . . . . .   (W at col 2, body-top row)
    //    r1: . . W . K . . . .   (sprite at col 4, body-bot row)
    //    r2: # # # # # # # # #
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '..W......',
      '..W.K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    // Spawn col 4, wall at col 2. Scan stops at col 2 → leftX = 3*16 = 48.
    expect(r.leftX).toBe(3 * 16)
    expect(r.leftKind).toBe('wall')
  })

  it('spawn column never self-blocks', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '....W....',    // wall sits in body-top row at spawn column
      '....K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    // Scan begins at col-1, so the wall at spawn col is never checked.
    expect(r.leftX).toBe(0)
  })

  it.each([
    [0x110, false],    // page-1, below $11 low byte
    [0x111, true],     // page-1, lower inclusive
    [0x16D, true],     // page-1, upper inclusive
    [0x16E, false],    // page-1, above upper (slope)
  ])('body-row acts-like $%s → wall=%s', (actsLike, expectWall) => {
    const tile = { actsLike }
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '..T......',
      '..T.K....',
      '#########',
    ], { '#': GROUND, 'T': tile, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    if (expectWall) expect(r.leftX).toBe(3 * 16)  // col 2 + 1 = col 3 → 48px
    else            expect(r.leftX).toBe(0)
  })

  it('priority-1 decorative tile in body row: never blocks (walls passable)', () => {
    // Priority-deco grass in the body rows should NOT stop the scan —
    // the isPriority flag makes solidH return false regardless of actsLike.
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '..G...G..',
      '....K....',
      '#########',
    ], { '#': GROUND, 'G': GRASS, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftX).toBe(0)
  })

  it('acts-like $11 exact lower bound: wall', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '..T......',
      '..T.K....',
      '#########',
    ], { '#': GROUND, 'T': WALL_11, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround).leftX).toBe(3 * 16)
  })

  it('acts-like $6D exact upper bound: wall', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '..T......',
      '..T.K....',
      '#########',
    ], { '#': GROUND, 'T': WALL_6D, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround).leftX).toBe(3 * 16)
  })

  it('acts-like $6E slope: not a wall — scan passes through', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '..T......',
      '..T.K....',
      '#########',
    ], { '#': GROUND, 'T': SLOPE, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround).leftX).toBe(0)
  })
})

describe('KoopaWalkBehavior.computePatrolRange — ledge scan', () => {
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  it('turnsAtLedges=true + gap in floor (left): stops at missing-floor column', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.........',
      '.....K...',
      '####.####',      // gap at col 4
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(5, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    // Scan LEFT from col 4: col 4 has no floor → turnLedge → leftX = 5*16.
    expect(r.leftX).toBe(5 * 16)
    expect(r.leftKind).toBe('turnLedge')
  })

  it('turnsAtLedges=false + gap in floor (left): fallLedge emitted', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.........',
      '.....K...',
      '####.####',      // gap at col 4
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(5, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftX).toBe(5 * 16)
    expect(r.leftKind).toBe('fallLedge')
    expect(r.leftIsWall).toBe(false)
  })

  it('priority-1 floor tile counts AS ground (sprite visually sits on it)', () => {
    // Previous behavior treated priority-deco as non-floor → ledge. New
    // behavior via the isPriority flag: hasGround returns true so the
    // scan walks across it. Visually the sprite stands on the grass.
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.....',
      '...K.',
      '##G##',     // grass (priority-1) at col 2 on the koopa's path left
    ], { '#': GROUND, 'G': GRASS, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    // No ledge on the priority-grass column — scan reaches the level edge.
    expect(r.leftX).toBe(0)
    expect(r.leftKind).toBe('levelEdge')
  })
})

describe('KoopaWalkBehavior.computePatrolRange — tall vs single-row body', () => {
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  it('tall=true: wall only in top body row still blocks (left)', () => {
    //    r0: . . W . . . . . .  ← top row has wall at col 2
    //    r1: . . . . K . . . .
    //    r2: # # # # # # # # #
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '..W......',
      '....K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround).leftX).toBe(3 * 16)
  })

  it('tall=false: top-row wall does NOT block (only scans bottom row)', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '..W......',
      '....K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: false, walkSpeed: 0x08 })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround).leftX).toBe(0)
  })

  it('tall=true: wall only in bottom body row blocks (left)', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.........',
      '..W.K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround).leftX).toBe(3 * 16)
  })
})

describe('KoopaWalkBehavior — integration', () => {
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  it('walls at both ends: patrol covers interior', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      'W.......W',
      'W...K...W',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    // Left scan stops at wall; right is clamped to sprite's right edge.
    expect(r.leftX).toBe(1 * 16)
    expect(r.leftKind).toBe('wall')
    expect(r.rightX).toBe(5 * 16)
  })

  it('exposes metadata for overlay rendering', () => {
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    expect(beh.kind).toBe('koopa_walk')
    expect(beh.turnsAtLedges).toBe(true)
    expect(beh.tall).toBe(true)
  })

  it('spawn at column 0: left edge terminates at 0', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '...',
      'K..',
      '###',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(0, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftX).toBe(0)
    expect(r.leftKind).toBe('levelEdge')
  })
})

describe('KoopaWalkBehavior — fallSide resolution', () => {
  // Koopas face LEFT at spawn and bounce off walls/turnLedges. The overlay
  // draws an L on whichever side the koopa ACTUALLY reaches — the first
  // obstacle going left, or (if that's a wall/turnLedge) the first obstacle
  // going right after the bounce. Level edges and trailing walls never get
  // an L: the koopa walks off-screen or oscillates forever.
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  it('ledge immediately to the LEFT (initial direction): fallSide=left', () => {
    //   r0: . . . . .
    //   r1: . . K . .
    //   r2: . . # # #     ledge at col 1 (leftward)
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.....',
      '..K..',
      '..###',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(2, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftKind).toBe('fallLedge')
    expect(r.fallSide).toBe('left')
  })

  it('wall LEFT: fallSide=null, right-scan is clipped (no bounce visualization)', () => {
    // The overlay doesn't draw the right-bounce path. A left wall ends
    // the corridor on the left; the right side clips to the sprite edge
    // and emits no fall indicator regardless of what's past it.
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.......',
      'W.K....',
      'W####..',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(2, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftKind).toBe('wall')
    expect(r.rightKind).toBe('levelEdge')
    expect(r.fallSide).toBeNull()
  })

  it('wall on left: fallSide=null (no L drawn)', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.........',
      'W...K...W',
      'W########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftKind).toBe('wall')
    expect(r.fallSide).toBeNull()
  })

  it('level edge on left (walks off-screen): fallSide=null', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '....',
      '..K.',
      '####',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(2, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftKind).toBe('levelEdge')
    expect(r.fallSide).toBeNull()
  })

  it('turnsAtLedges=true: left ledge counts as turnLedge, fallSide=null', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '..###..',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftKind).toBe('turnLedge')
    expect(r.fallSide).toBeNull()
  })

  it('turnsAtLedges=false + gap in floor: patrol ends at ledge + fallSide set', () => {
    // (migrated from the old "walks past gap to wall" test — under the new
    // fallLedge semantics, the koopa stops at the first ledge going left.)
    //   r0: . . . . . . . . .
    //   r1: . . . . K . . . .
    //   r2: . . . . # # # # #    floor gap at cols 0-2
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.........',
      '....K....',
      '....#####',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftKind).toBe('fallLedge')
    expect(r.fallSide).toBe('left')
  })

  it('slopes are walkable ground (acts-like $6E): no fall-ledge on slope column', () => {
    // Koopa on flat ground with a slope ($6E) to its left. The slope is
    // NOT a fall-ledge — the sprite walks onto it. Regression guard: if
    // the floor check were `solidV` (narrow range, excludes $6E+), the
    // slope column would be mis-classified as a ledge and the overlay
    // would emit a spurious L-fall. This exact misclassification was
    // the visible bug on vanilla slopes.
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '#S#####',
    ], { '#': GROUND, 'S': SLOPE, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    // Scan walks over the slope to the level edge, no fall emitted.
    expect(r.leftX).toBe(0)
    expect(r.leftKind).toBe('levelEdge')
    expect(r.fallSide).toBeNull()
  })

  it('priority-decorative grass at floor row + solid below: no ledge (tolerance)', () => {
    // Vanilla SMW grass-on-dirt layout: priority-1 grass sits at the
    // koopa's floorRow and is filtered to null by the getL1 closure
    // (it's foreground decoration). The actual solid tile is one row
    // deeper. Without the +1 row tolerance, the scan sees null at
    // floorRow and emits a spurious fallLedge on every column.
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.......',
      '...K...',       // sprite at rowBot=1
      'GGGGGGG',       // floorRow=2 — priority-1 grass (filtered)
      '#######',       // actual solid ground — one row below
    ], { '#': GROUND, 'G': GRASS, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    // With tolerance, the scan finds solid ground at floorRow+1 → no ledge.
    expect(r.leftKind).toBe('levelEdge')
    expect(r.fallSide).toBeNull()
  })

  it('sprite spawned airborne: patrol row = first ground below, spawnDropFromY set', () => {
    // Koopa placed 3 rows above the ground. The effective patrol floor
    // is row 5 (the first solid tile at the spawn column), not row 2
    // (one row below spawn). spawnDropFromY indicates the fall-to-floor.
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.......',    // r0
      '...K...',    // r1 — spawn (rowBot=1)
      '.......',    // r2 — spawn's floorRow, empty
      '.......',    // r3 — empty
      '.......',    // r4 — empty
      '#######',    // r5 — actual ground
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    // floorRowEff = 5 → bottomY = 5*16 = 80. rowBotEff = 4, rowTopEff = 3
    // → topY = 3*16 = 48.
    expect(r.bottomY).toBe(5 * 16)
    expect(r.topY).toBe(3 * 16)
    // spawn body bottom = (rowBotSpawn + 1) * 16 = 2 * 16 = 32.
    expect(r.spawnDropFromY).toBe(2 * 16)
  })

  it('sprite spawned on ground: spawnDropFromY is undefined', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '#######',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.spawnDropFromY).toBeUndefined()
  })

  it('sprite spawned airborne with no ground below: spawnDropFromY still set, bottomY at level bottom', () => {
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '.......',
      '.......',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    // No ground found → floorRowEff = levelRows (4), bottomY = 64.
    expect(r.bottomY).toBe(rows * 16)
    expect(r.spawnDropFromY).toBe(2 * 16)
  })

  it('slopes count as ground for turnsAtLedges=true koopas too: corridor spans slope', () => {
    // Red koopa ($05, turnsAtLedges=true). Same regression guard as
    // above but via the turnLedge path — with the old narrow floor check
    // the corridor stopped at the slope column (spurious turnLedge).
    const { solidH, solidV, hasGround, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '#S#####',
    ], { '#': GROUND, 'S': SLOPE, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, hasGround)
    expect(r.leftX).toBe(0)
    expect(r.leftKind).toBe('levelEdge')
  })
})
