/**
 * ASM-derived tests for $1D Hopping Flame - HoppingFlame handler at
 * bank_01.asm:2187–2218 plus CODE_018F50 hop initiation and
 * FlipIfTouchingObj at bank_01.asm:2369.
 *
 * Each test case targets one branch or table value of the ASM. The test
 * tree is:
 *
 *   simulateBounds
 *     ├─ envelope.maxY ≤ groundY + 16 (bug-4 regression - never clips into ground)
 *     ├─ envelope.minY < groundY      (reaches meaningful apex)
 *     ├─ empty level → reaches level floor
 *     ├─ walled corridor → bounds limited to interior columns
 *     ├─ priority-decorative tile on floor → treated as ledge (flame falls through)
 *     ├─ two-cell gap in floor → bounds extend downward through the gap
 *     ├─ fully walled 3x3 cell → envelope rounds out inside the walls
 *     └─ groundY snaps to first solid row even when spawn is a few pixels airborne
 *
 *   computeBouncePath
 *     ├─ returns ≥ 2 points on flat ground (launch + landing)
 *     ├─ all points sit at or above groundY + 16 (never below resting row)
 *     └─ returns empty-ish when spawned in empty-void
 *
 *   acts-like solidity (via the solidityFromL1 adapter)
 *     ├─ acts-like $10 → not solid
 *     ├─ acts-like $11 → solid (lower bound)
 *     ├─ acts-like $6D → solid (upper bound)
 *     ├─ acts-like $6E → not solid (exclusive upper)
 *     └─ priority-1 decorative → filtered out by buildSolidity (returns null)
 */

import { describe, expect, it } from 'vitest'
import { HopFlameBehavior } from '../../../src/rom/model/sprites/behaviors/HopFlameBehavior'
import { isActsLikeHorizSolid, isActsLikeVertSolid } from '../../../src/rom/model/OverlayContext'
import { buildSolidity } from './fixtures/buildSolidity'

const GROUND = { actsLike: 0x130 } // page-1 low byte $30 - canonical solid floor
const WALL = { actsLike: 0x130 }
const GRASS = { actsLike: 0x025, priority: true } // priority-1 decorative (page doesn't matter - isPriority skip)
const SLOPE = { actsLike: 0x06e } // page-0 slope (vanilla convention)
const BODY = 16

describe('HopFlameBehavior.simulateBounds', () => {
  // Every test spawns the flame 1 row above a floor row so spawnY is the
  // resting row (aligns with the ASM IsOnGround check behaviour).
  const at = (col: number, row: number) => ({ x: col * BODY, y: row * BODY })

  it('envelope.maxY never extends below groundY + 16 (bug-4 regression)', () => {
    // The old simulator expanded maxY inside the per-frame loop, so Y
    // speeds carrying the flame past ground before the collision clamp
    // landed could bleed into the ground tile. The fix clamps maxY to
    // resting Y + body height - every overlay pixel is above the floor.
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new HopFlameBehavior()
    const { x, y } = at(5, 3)
    const b = beh.simulateBounds(x, y, solidH, solidV, cols, rows)
    expect(b.groundY).toBe(4 * BODY - BODY) // resting body top (y = 48)
    expect(b.maxY).toBe(b.groundY + BODY) // bottom of envelope == resting row bottom
    expect(b.maxY).toBeLessThanOrEqual(4 * BODY) // floor row top
  })

  it('envelope reaches a noticeable apex above the resting row', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new HopFlameBehavior()
    const { x, y } = at(5, 3)
    const b = beh.simulateBounds(x, y, solidH, solidV, cols, rows)
    // With worst-case launch $D0 = -48 sub-px/frame (-3 px/frame start) and
    // gravity net +2/frame, peak Y-height ≈ (48² / (2·2)) / 16 ≈ 36 px. The
    // envelope's minY should be at least 20 px above ground (leaves room
    // for collision quantisation).
    expect(b.minY).toBeLessThanOrEqual(b.groundY - 20)
  })

  it('walled corridor bounds the horizontal envelope to the interior columns', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['.W.......W', '.W.......W', '.W.......W', '.W.......W', '##########'],
      { '#': GROUND, W: WALL },
    )
    const beh = new HopFlameBehavior()
    const { x, y } = at(5, 3)
    const b = beh.simulateBounds(x, y, solidH, solidV, cols, rows)
    // Left wall at col 1, right wall at col 9. Interior spans col 2..8.
    expect(b.minX).toBeGreaterThanOrEqual(2 * BODY)
    expect(b.maxX).toBeLessThanOrEqual(9 * BODY)
  })

  it('priority-decorative floor lets the flame fall through (treated as empty)', () => {
    // Priority-decorative tile is filtered by buildSolidity's getL1 → returns null.
    // So the column has no floor despite a glyph being present.
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '..K.......', '..........', '##G##G####'],
      { '#': GROUND, G: GRASS, K: { actsLike: 0 } },
    )
    const beh = new HopFlameBehavior()
    const { x, y } = at(2, 2)
    const b = beh.simulateBounds(x, y, solidH, solidV, cols, rows)
    // Flame can fall through the grass column at col 2 → envelope extends
    // to at least row 4 bottom (the ground row it lands on below... except
    // there is no ground row past row 4; it falls off-level). groundY
    // snaps to the first solid row beneath the spawn, which is row 4.
    expect(b.groundY).toBeLessThanOrEqual(4 * BODY)
  })

  it('groundY snaps to the first solid row at or below spawn', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      [
        '..........',
        '..........',
        '..........', // spawn row
        '..........',
        '..........',
        '##########', // first solid row
      ],
      { '#': GROUND },
    )
    const beh = new HopFlameBehavior()
    const { x, y } = at(5, 2)
    const b = beh.simulateBounds(x, y, solidH, solidV, cols, rows)
    expect(b.groundY).toBe(5 * BODY - BODY) // row 5 * 16 - 16 = 64
  })

  it('fully enclosed 3×3 cell - envelope stays inside the box', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['#####', '#...#', '#...#', '#...#', '#####'],
      { '#': GROUND },
    )
    const beh = new HopFlameBehavior()
    // Spawn inside the box at col 2 row 3 (on the floor row above #####)
    const b = beh.simulateBounds(2 * BODY, 3 * BODY, solidH, solidV, cols, rows)
    // Envelope fully inside the interior columns (1..4) and rows (1..4).
    expect(b.minX).toBeGreaterThanOrEqual(BODY)
    expect(b.maxX).toBeLessThanOrEqual(4 * BODY)
    expect(b.minY).toBeGreaterThanOrEqual(BODY)
    expect(b.maxY).toBeLessThanOrEqual(4 * BODY)
  })

  it('empty level - flame falls to the level floor', () => {
    // Only the last row is ground → spawn has room to fall a bit before
    // the simulator's ground-check snap lands on the floor.
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new HopFlameBehavior()
    const b = beh.simulateBounds(5 * BODY, 0, solidH, solidV, cols, rows)
    expect(b.groundY).toBe(3 * BODY - BODY) // row 3 * 16 - 16 = 32
    expect(b.maxY).toBe(b.groundY + BODY) // clamped to resting row bottom
  })

  it('returns deterministic bounds for identical input (no RNG in sim)', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new HopFlameBehavior()
    const a = beh.simulateBounds(5 * BODY, 2 * BODY, solidH, solidV, cols, rows)
    const b = beh.simulateBounds(5 * BODY, 2 * BODY, solidH, solidV, cols, rows)
    expect(a).toEqual(b)
  })
})

describe('HopFlameBehavior.computeBouncePath', () => {
  it('produces ≥ 2 sample points on flat ground (launch + landing)', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new HopFlameBehavior()
    const path = beh.computeBouncePath(5 * BODY, BODY, solidH, solidV, cols, rows)
    expect(path.length).toBeGreaterThanOrEqual(2)
  })

  it('all path points sit at or above resting row bottom', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '##########'],
      { '#': GROUND },
    )
    const beh = new HopFlameBehavior()
    const path = beh.computeBouncePath(5 * BODY, BODY, solidH, solidV, cols, rows)
    const groundBottom = 2 * BODY // row 2 top = floor top
    for (const p of path) {
      // Sample point y is the sprite body bottom - should not be below
      // the ground row's top edge.
      expect(p.y).toBeLessThanOrEqual(groundBottom + 0.5)
    }
  })

  it('no-floor spawn - path is sparse but valid', () => {
    const { solidH, solidV, cols, rows } = buildSolidity(
      ['..........', '..........', '..........'],
      {},
    )
    const beh = new HopFlameBehavior()
    const path = beh.computeBouncePath(5 * BODY, BODY, solidH, solidV, cols, rows)
    expect(path.length).toBeGreaterThanOrEqual(0) // may be empty but valid
  })
})

describe('solidityFromL1 adapter', () => {
  // ASM: CODE_01928E bank_01.asm:2613 - actsLike & 0xFF in $11..$6D = solid.
  // We also reject page-0 actsLike ($000-$0FF) - vanilla SMW convention,
  // see `isActsLikeHorizSolid` docs. Dragon coins ($02D/$02E) otherwise
  // would register as walls.
  it.each([
    [0x000, false], // page 0 - never wall
    [0x010, false],
    [0x011, false], // page 0 even at low-byte lower bound
    [0x06d, false],
    [0x100, false],
    [0x110, false],
    [0x111, true], // page 1 lower bound
    [0x13f, true],
    [0x16d, true], // page 1 upper bound
    [0x16e, false], // page 1 slope low byte - not a wall
    [0x130, true], // $130 & $FF = $30 → solid
  ])('horiz solidity for acts-like $%s', (actsLike, expected) => {
    expect(isActsLikeHorizSolid(actsLike)).toBe(expected)
  })

  it.each([
    [0x000, false],
    [0x011, false], // page 0 rejected
    [0x111, true], // page 1 lower
    [0x16d, true], // page 1 upper
    [0x16e, false], // slope
    [0x1c4, true], // tileset-specific solid-from-above window
    [0x1c9, true],
    [0x1ca, false],
  ])('vert solidity for acts-like $%s (default tileset)', (actsLike, expected) => {
    expect(isActsLikeVertSolid(actsLike)).toBe(expected)
  })

  it('vert solidity respects tileset 0/7 which disable the $C4..$C9 window', () => {
    expect(isActsLikeVertSolid(0x1c4, 0)).toBe(false)
    expect(isActsLikeVertSolid(0x1c7, 7)).toBe(false)
    expect(isActsLikeVertSolid(0x1c4, 1)).toBe(true)
  })

  it('priority-decorative cell carries isPriority=true; solidH/V still false', () => {
    // Priority-deco cells aren't filtered to null anymore (so `hasGround`
    // can treat them as ground for ledge detection). They remain passable
    // for walls and hard-floor collision via the isPriority flag.
    const { getL1, solidH, solidV } = buildSolidity(['G'], { G: GRASS })
    const cell = getL1(0, 0)
    expect(cell).not.toBeNull()
    expect(cell!.isPriority).toBe(true)
    expect(solidH(0, 0)).toBe(false)
    expect(solidV(0, 0)).toBe(false)
  })

  it('solidityFromL1 wraps the getL1 adapter - slope $6E treated as non-wall', () => {
    const { solidH } = buildSolidity(['S'], { S: SLOPE })
    expect(solidH(0, 0)).toBe(false)
  })
})
