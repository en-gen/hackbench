/**
 * ASM-derived tests for ground-walking koopas ($04/$05/$06/$07/$0C, + family
 * handlers Goomba $0F / Buzzy Beetle $11 / Spiny $13) — the `Spr0to13Main`
 * handler at bank_01.asm:1659–1747, wall check `CODE_01928E` at 2613, floor
 * check `CODE_01933B` at 2705, ledge-turn check `SpriteInAir` at 1718.
 *
 * Also covers Dry Bones $30/$32 — DryBonesAndBeetle handler at
 * bank_01.asm:13520, which reuses the same wall check (FlipIfTouchingObj)
 * and floor check (SpriteInAir) as Spr0to13Main. Walk speed DATA_01E41F[0]=$08
 * (FAST). $30 walks off ledges; $32 reverses via SpriteTableC2 air-to-ground
 * transition flip (same observable effect as turnsAtLedges=true in Koopa).
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
 *   $0C = $DD → bit 1=0, bit 6=1 → turnsAtLedges=false, tall=true
 *   $0F = $20 → bit 1=0, bit 6=0 → turnsAtLedges=false, tall=false (Goomba)
 *
 * Dry Bones (bank_01.asm:13520, DATA_01E41F):
 *   $30 → turnsAtLedges=false, tall=true, walkSpeed=$08 (falls off ledges)
 *   $32 → turnsAtLedges=true,  tall=true, walkSpeed=$08 (stays on ledge)
 *
 * Test tree:
 *
 *   propsFromSpriteId (factory helper) — bit extraction
 *     ├─ $04/$05/$06/$07/$0C produce expected (turnsAtLedges, tall) tuples
 *     ├─ $0F Goomba: tall=false (one-row body)
 *     ├─ $30 Dry Bones (throws): turnsAtLedges=false, tall=true, walkSpeed=$08
 *     └─ $32 Dry Bones (ledge): turnsAtLedges=true,  tall=true, walkSpeed=$08
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
const SLOPE  = { actsLike: 0x16E }           // page-1 slope (low byte $6E, slopeTable=true)
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
    [0x0C, { turnsAtLedges: true,  tall: true,  walkSpeed: 0x0C }],
    [0x0F, { turnsAtLedges: false, tall: false, walkSpeed: 0x08 }],  // Goomba — bit 6 clear, fast
    // ASM: bank_01.asm:13520 — DryBonesAndBeetle; DATA_01E41F[0]=$08 walk speed.
    [0x30, { turnsAtLedges: false, tall: true,  walkSpeed: 0x08 }],  // throws bones, falls off ledges
    [0x32, { turnsAtLedges: true,  tall: true,  walkSpeed: 0x08 }],  // stays on ledge
  ])('spriteId $%s produces expected config', (id, expected) => {
    expect(propsFromSpriteId(id)).toEqual(expected)
  })

  it('unknown id returns a safe fallback (non-turning, tall, slow)', () => {
    expect(propsFromSpriteId(0xFF)).toEqual({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
  })
})

describe('KoopaWalkBehavior.computePatrolRange — wall scan', () => {
  // Both sides are always scanned. Wall/slope/acts-like probe tiles are
  // placed LEFT of the spawn column so the right scan reaches the level edge
  // and doesn't interfere with the assertion under test.
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  it('empty corridor, turnsAtLedges=true: scans both directions, both reach level edge', () => {
    // Ledge-turning koopas ($05/$06) patrol between BOTH boundaries;
    // both sides get scanned. In an empty corridor, neither direction
    // hits an obstacle, so both sides land on the level edge.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.........',
      '....K....',
      '#########',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.leftX).toBe(0)
    expect(r.rightX).toBe(cols * 16)
    expect(r.leftKind).toBe('levelEdge')
    expect(r.rightKind).toBe('levelEdge')
  })

  it('empty corridor, turnsAtLedges=false: right scans to level edge', () => {
    // Non-turning koopas now scan both sides — right reaches the level edge
    // when there is no obstacle.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.........',
      '....K....',
      '#########',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.rightX).toBe(cols * 16)
    expect(r.rightKind).toBe('levelEdge')
  })

  it('wall at col-3 to the left: leftX = (col+1)*16 = 32', () => {
    //    r0: . . W . . . . . .   (W at col 2, body-top row)
    //    r1: . . W . K . . . .   (sprite at col 4, body-bot row)
    //    r2: # # # # # # # # #
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..W......',
      '..W.K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    // Spawn col 4, wall at col 2. Scan stops at col 2 → leftX = 3*16 = 48.
    expect(r.leftX).toBe(3 * 16)
    expect(r.leftKind).toBe('wall')
  })

  it('spawn column never self-blocks', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '....W....',    // wall sits in body-top row at spawn column
      '....K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
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
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..T......',
      '..T.K....',
      '#########',
    ], { '#': GROUND, 'T': tile, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    if (expectWall) expect(r.leftX).toBe(3 * 16)  // col 2 + 1 = col 3 → 48px
    else            expect(r.leftX).toBe(0)
  })

  it('priority-1 decorative tile in body row: never blocks (walls passable)', () => {
    // Priority-deco grass in the body rows should NOT stop the scan —
    // the isPriority flag makes solidH return false regardless of actsLike.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..G...G..',
      '....K....',
      '#########',
    ], { '#': GROUND, 'G': GRASS, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.leftX).toBe(0)
  })

  it('acts-like $11 exact lower bound: wall', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..T......',
      '..T.K....',
      '#########',
    ], { '#': GROUND, 'T': WALL_11, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows).leftX).toBe(3 * 16)
  })

  it('acts-like $6D exact upper bound: wall', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..T......',
      '..T.K....',
      '#########',
    ], { '#': GROUND, 'T': WALL_6D, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows).leftX).toBe(3 * 16)
  })

  it('acts-like $6E slope: not a wall — scan passes through', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..T......',
      '..T.K....',
      '#########',
    ], { '#': GROUND, 'T': SLOPE, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows).leftX).toBe(0)
  })
})

describe('KoopaWalkBehavior.computePatrolRange — ledge scan', () => {
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  it('turnsAtLedges=true + gap in floor (left): stops at missing-floor column', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.........',
      '.....K...',
      '####.####',      // gap at col 4
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(5, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    // Scan LEFT from col 4: col 4 has no floor → turnLedge → leftX = 5*16.
    expect(r.leftX).toBe(5 * 16)
    expect(r.leftKind).toBe('turnLedge')
  })

  it('turnsAtLedges=false + gap in floor (left): fallLedge emitted', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.........',
      '.....K...',
      '####.####',      // gap at col 4
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(5, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.leftX).toBe(5 * 16)
    expect(r.leftKind).toBe('fallLedge')
    expect(r.solidLeft).toBe(false)
  })

  it('priority-1 floor tile at floor row: treated as no-floor (turnLedge)', () => {
    // Priority-deco has NO_COLLISION and isPriority=true. solidV returns
    // false for priority tiles, so a floor row with only priority grass
    // and no solid below reads as a ledge — matches how SmwMap filters
    // these tiles (production getL1 returns null for all-priority cells).
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.....',
      '...K.',
      '##G##',     // grass (priority-1) at col 2 on the koopa's path left, no solid below
    ], { '#': GROUND, 'G': GRASS, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    // No solid floor at the grass column → turnLedge boundary at (col+1)*16 = 3*16 = 48.
    expect(r.leftX).toBe(3 * 16)
    expect(r.leftKind).toBe('turnLedge')
  })
})

describe('KoopaWalkBehavior.computePatrolRange — tall vs single-row body', () => {
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  it('tall=true: wall only in top body row still blocks (left)', () => {
    //    r0: . . W . . . . . .  ← top row has wall at col 2
    //    r1: . . . . K . . . .
    //    r2: # # # # # # # # #
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..W......',
      '....K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows).leftX).toBe(3 * 16)
  })

  it('tall=false: top-row wall does NOT block (only scans bottom row)', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '..W......',
      '....K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: false, walkSpeed: 0x08 })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows).leftX).toBe(0)
  })

  it('tall=true: wall only in bottom body row blocks (left)', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.........',
      '..W.K....',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    expect(beh.computePatrolRange(x, y, solidH, solidV, cols, rows).leftX).toBe(3 * 16)
  })
})

describe('KoopaWalkBehavior — integration', () => {
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  it('walls at both ends: patrol covers full interior, fallSide=null', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      'W.......W',
      'W...K...W',
      '#########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    // Both sides scan to their respective walls; neither is a fallLedge.
    expect(r.leftX).toBe(1 * 16)
    expect(r.leftKind).toBe('wall')
    expect(r.rightX).toBe(8 * 16)
    expect(r.rightKind).toBe('wall')
    expect(r.fallSide).toBeNull()
  })

  it('exposes metadata for overlay rendering', () => {
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    expect(beh.kind).toBe('koopa_walk')
    expect(beh.turnsAtLedges).toBe(true)
    expect(beh.tall).toBe(true)
  })

  it('spawn at column 0: left edge terminates at 0', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '...',
      'K..',
      '###',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(0, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
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
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.....',
      '..K..',
      '..###',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(2, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('fallLedge')
    expect(r.fallSide).toBe('left')
  })

  it('wall LEFT + fallLedge RIGHT: koopa bounces and falls right, fallSide=right', () => {
    // Non-turning koopa hits left wall, bounces rightward, and falls off the
    // right ledge. The overlay must scan the right side and emit fallSide=right.
    //   r0: . . . . . . .
    //   r1: W . K . . . .   ← spawn at col 2; wall at col 0
    //   r2: W # # # # . .   ← floor at cols 1-4; gap (ledge) at cols 5-6
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      'W.K....',
      'W####..',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(2, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('wall')
    expect(r.rightKind).toBe('fallLedge')
    expect(r.fallSide).toBe('right')
  })

  it('walls on both sides: perpetual bounce, fallSide=null', () => {
    // Koopa bounces between two walls indefinitely — no fall indicator.
    // Right scan now runs and finds the right wall.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.........',
      'W...K...W',
      'W########',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('wall')
    expect(r.rightKind).toBe('wall')
    expect(r.rightX).toBe(8 * 16)
    expect(r.fallSide).toBeNull()
  })

  it('level edge on left (walks off-screen): fallSide=null', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '....',
      '..K.',
      '####',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(2, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('levelEdge')
    expect(r.fallSide).toBeNull()
  })

  it('turnsAtLedges=true: left ledge counts as turnLedge, fallSide=null', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '..###..',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('turnLedge')
    expect(r.fallSide).toBeNull()
  })

  it('turnsAtLedges=false + gap in floor: patrol ends at ledge + fallSide set', () => {
    // (migrated from the old "walks past gap to wall" test — under the new
    // fallLedge semantics, the koopa stops at the first ledge going left.)
    //   r0: . . . . . . . . .
    //   r1: . . . . K . . . .
    //   r2: . . . . # # # # #    floor gap at cols 0-2
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.........',
      '....K....',
      '....#####',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
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
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '#S#####',
    ], { '#': GROUND, 'S': SLOPE, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    // Scan walks over the slope to the level edge, no fall emitted.
    expect(r.leftX).toBe(0)
    expect(r.leftKind).toBe('levelEdge')
    expect(r.fallSide).toBeNull()
  })

  it('priority-decorative grass at floor row + solid below: no ledge (terrain-follow)', () => {
    // Vanilla SMW grass-on-dirt layout: priority-1 grass sits at the
    // koopa's floorRow and is filtered to null by the getL1 closure
    // (it's foreground decoration). The actual solid tile is one row
    // deeper. The ±1 terrain-following window finds solid at floorRow+1.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      '...K...',       // sprite at rowBot=1
      'GGGGGGG',       // floorRow=2 — priority-1 grass (filtered → floor=false)
      '#######',       // actual solid ground — one row below at row 3
    ], { '#': GROUND, 'G': GRASS, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    // Terrain-following scan finds solid ground at row 3 → no ledge.
    expect(r.leftKind).toBe('levelEdge')
    expect(r.fallSide).toBeNull()
  })

  it('genuine 2-row drop at floor row: ledge (beyond ±1 window)', () => {
    // A drop of 2 rows cannot be traversed by the ±1 terrain-following scan —
    // the koopa would be briefly airborne and SpriteInAir fires. The scan
    // must stop when no floor exists within ±1 of the current floor row.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      '...K...',       // sprite at rowBot=1
      '####...',       // floorRow=2: solid cols 0-3, genuine air at 4-6
    ], { '#': GROUND, 'K': PASS })
    // No row 3 — gap at cols 4-6 has nothing within ±1 of floorRow=2.
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    // col 4 has no floor within ±1 → turnLedge.
    expect(r.rightKind).toBe('turnLedge')
    expect(r.rightX).toBe(4 * 16)
  })

  it('sprite spawned airborne: patrol row = first ground below, spawnDropFromY set', () => {
    // Koopa placed 3 rows above the ground. The effective patrol floor
    // is row 5 (the first solid tile at the spawn column), not row 2
    // (one row below spawn). spawnDropFromY indicates the fall-to-floor.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',    // r0
      '...K...',    // r1 — spawn (rowBot=1)
      '.......',    // r2 — spawn's floorRow, empty
      '.......',    // r3 — empty
      '.......',    // r4 — empty
      '#######',    // r5 — actual ground
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    // floorRowEff = 5 → bottomY = 5*16 = 80. rowBotEff = 4, rowTopEff = 3
    // → topY = 3*16 = 48.
    expect(r.bottomY).toBe(5 * 16)
    expect(r.topY).toBe(3 * 16)
    // spawn body bottom = (rowBotSpawn + 1) * 16 = 2 * 16 = 32.
    expect(r.spawnDropFromY).toBe(2 * 16)
  })

  it('sprite spawned on ground: spawnDropFromY is undefined', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '#######',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.spawnDropFromY).toBeUndefined()
  })

  it('sprite spawned airborne with no ground below: spawnDropFromY still set, bottomY at level bottom', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '.......',
      '.......',
    ], { '#': GROUND, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    // No ground found → floorRowEff = levelRows (4), bottomY = 64.
    expect(r.bottomY).toBe(rows * 16)
    expect(r.spawnDropFromY).toBe(2 * 16)
  })

  it('slopes count as ground for turnsAtLedges=true koopas too: corridor spans slope', () => {
    // Red koopa ($05, turnsAtLedges=true). Same regression guard as
    // above but via the turnLedge path — with the old narrow floor check
    // the corridor stopped at the slope column (spurious turnLedge).
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      '...K...',
      '#S#####',
    ], { '#': GROUND, 'S': SLOPE, 'K': PASS })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(3, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows)
    expect(r.leftX).toBe(0)
    expect(r.leftKind).toBe('levelEdge')
  })
})

describe('KoopaWalkBehavior — patrol bounds with SurfacePath', () => {
  // Integration check: a synthetic stair-step slope (modelled after the
  // level-006 col 92-95 region) — koopa walks LEFT off a flat top onto
  // a descending slope. Patrol bounds should reach the level edge with
  // bottomY tracking the descending surface, not clip at any column.
  //
  // The harder algorithmic question — "do we pick the lower slope, not
  // the upper, at a slope corner where both surfaces stack in the same
  // column?" — is exercised in `SurfacePath.test.ts` against a known-
  // wrong baseline (mid-pixel sampling). Here we only assert that the
  // koopa scan plumbs the SurfacePath through and gets a complete walk.
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })

  type SyntheticTile = { actsLike: number; heights?: readonly number[] }
  function makeGrid(grid: string[], defs: Record<string, SyntheticTile>) {
    const rows = grid.length
    const cols = grid[0].length
    type Cell = { id: number; actsLike: number; collision: ReturnType<typeof classify> }
    const cells = new Map<string, Cell | null>()
    cells.set('.', null)
    let nextId = 0x100
    function classify(def: SyntheticTile) {
      const low = def.actsLike & 0xFF
      const inSolid = low >= 0x11 && low <= 0x6D
      const inSlope = low >= 0x6E && low <= 0xD7
      return {
        wall:         inSolid,
        floor:        low <= 0x10 ? false : (inSolid || inSlope || low >= 0xD8),
        ceiling:      inSolid,
        slopeTable:   inSlope,
        marioFloor:   false,
        marioCeiling: false,
        marioWall:    false,
        slope: def.heights
          ? { slopeIndex: 0, heights: new Uint8Array(def.heights) }
          : undefined,
      }
    }
    for (const [ch, def] of Object.entries(defs)) {
      cells.set(ch, { id: nextId++, actsLike: def.actsLike, collision: classify(def) })
    }
    const getL1 = (c: number, r: number) => {
      if (c < 0 || c >= cols || r < 0 || r >= rows) return null
      return cells.get(grid[r][c]) ?? null
    }
    const solidH: SolidH = (c, r) => getL1(c, r)?.collision.wall  ?? false
    const solidV: SolidV = (c, r) => getL1(c, r)?.collision.floor ?? false
    return { getL1, solidH, solidV, cols, rows }
  }

  it('top-to-bottom wall column (no floor surface): leftKind=wall, NOT fallLedge', () => {
    // Regression for level $134: col 0 is wall ($14C) from row 0 to row 175.
    // No floor surface exists AT col 0 — the wall is solid top-to-bottom — so
    // `path.nextSurface(0, ...)` returns null. The wall check must still fire,
    // classifying col 0 as a WALL rather than a fallLedge. Without this, the
    // overlay shows a spurious fall indicator at the inside edge of any
    // level-bounding wall (every vertical level, every screen-edge wall).
    const W = { actsLike: 0x130 }     // page-1 wall
    const F = { actsLike: 0x130 }     // page-1 floor (same range)
    const { getL1, solidH, solidV, cols, rows } = makeGrid([
      'W........',
      'W........',
      'W...K....',
      'WFFFFFFFF',
    ], { 'W': W, 'F': F })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: false, tall: true, walkSpeed: 0x0C })
    const { x, y } = at(4, 2)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, getL1)
    expect(r.leftKind).toBe('wall')
    expect(r.leftX).toBe(1 * 16)
    expect(r.solidLeft).toBe(true)
  })

  it('koopa walks left across a 1-row flat step down, surface follows', () => {
    // Higher floor at cols 4-7 row 2; lower floor at cols 0-7 row 3.
    // Walking left, the koopa transitions from row 2 to row 3 at col 3
    // — a 16-px drop, exactly at the SurfacePath edge tolerance.
    const FLR = { actsLike: 0x130 }
    const { getL1, solidH, solidV, cols, rows } = makeGrid([
      '........',  // r0
      '......K.',  // r1 sprite spawn col 6
      '....####',  // r2 upper floor cols 4-7
      '########',  // r3 lower floor cols 0-7
    ], { '#': FLR })
    const beh = new KoopaWalkBehavior({ turnsAtLedges: true, tall: false, walkSpeed: 0x0C })
    const { x, y } = at(6, 1)
    const r = beh.computePatrolRange(x, y, solidH, solidV, cols, rows, getL1)
    expect(r.bottomY).toBe(32)
    expect(r.leftKind).toBe('levelEdge')
    expect(r.leftX).toBe(0)
  })
})

// ASM: bank_01.asm:13520 — DryBonesAndBeetle. Same wall check (FlipIfTouchingObj)
// and ledge check (SpriteInAir) as Spr0to13Main. DATA_01E41F[0]=$08 walk speed.
// $30 walks off ledges (turnsAtLedges=false); $32 reverses at ledge edges
// via SpriteTableC2 air-to-ground transition (turnsAtLedges=true).
describe('KoopaWalkBehavior — Dry Bones $30 (turnsAtLedges=false)', () => {
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })
  const behavior = new KoopaWalkBehavior(propsFromSpriteId(0x30))

  it('open ledge to the left (initial direction): fallSide=left', () => {
    // $30 spawns facing Mario. Walking left off an open ledge — fallSide=left,
    // overlay draws L-arm into the pit. Matches bank_01.asm:13520 ledge path.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      '..K....',
      '..#####',    // floor starts at col 2; pit at cols 0-1
    ], { '#': GROUND, 'K': PASS })
    const r = behavior.computePatrolRange(at(2, 1).x, at(2, 1).y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('fallLedge')
    expect(r.fallSide).toBe('left')
    expect(r.solidLeft).toBe(false)
  })

  it('wall left + fallLedge right: bounces off wall, falls right, fallSide=right', () => {
    // $30 hits left wall → bounces → walks right → falls off right ledge.
    // Wall classification must be independent of surface lookup (CODE_01928E).
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      'W.K....',
      'W####..',    // floor cols 1-4; pit cols 5-6
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const r = behavior.computePatrolRange(at(2, 1).x, at(2, 1).y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('wall')
    expect(r.solidLeft).toBe(true)
    expect(r.rightKind).toBe('fallLedge')
    expect(r.fallSide).toBe('right')
  })

  it('walls both sides: perpetual bounce, fallSide=null', () => {
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.........',
      'W...K...W',
      'W#######W',
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const r = behavior.computePatrolRange(at(4, 1).x, at(4, 1).y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('wall')
    expect(r.rightKind).toBe('wall')
    expect(r.solidLeft).toBe(true)
    expect(r.solidRight).toBe(true)
    expect(r.fallSide).toBeNull()
  })
})

describe('KoopaWalkBehavior — Dry Bones $32 (turnsAtLedges=true)', () => {
  const at = (c: number, r: number) => ({ x: c * 16, y: r * 16 })
  const behavior = new KoopaWalkBehavior(propsFromSpriteId(0x32))

  it('open ledge both sides: both turnLedge, fallSide=null, both boundaries solid', () => {
    // $32 reverses at ledge edges on both sides — perpetual back-and-forth.
    // solidLeft=solidRight=true because turnLedge is a stopping boundary.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      '..K....',
      '..###..',    // floor only under cols 2-4; pits at 0-1 and 5-6
    ], { '#': GROUND, 'K': PASS })
    const r = behavior.computePatrolRange(at(2, 1).x, at(2, 1).y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('turnLedge')
    expect(r.rightKind).toBe('turnLedge')
    expect(r.solidLeft).toBe(true)
    expect(r.solidRight).toBe(true)
    expect(r.fallSide).toBeNull()
  })

  it('left wall + right turnLedge: both stopping boundaries, fallSide=null', () => {
    // Wall left, open pit right — $32 treats the pit as a turnaround.
    const { solidH, solidV, cols, rows } = buildSolidity([
      '.......',
      'W.K....',
      'W####..',    // pit at cols 5-6
    ], { '#': GROUND, 'W': WALL, 'K': PASS })
    const r = behavior.computePatrolRange(at(2, 1).x, at(2, 1).y, solidH, solidV, cols, rows)
    expect(r.leftKind).toBe('wall')
    expect(r.rightKind).toBe('turnLedge')
    expect(r.solidLeft).toBe(true)
    expect(r.solidRight).toBe(true)
    expect(r.fallSide).toBeNull()
  })
})
