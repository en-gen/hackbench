/**
 * Unit tests for spriteCollisionFromL1 - the shared predicate bundle that
 * consolidated priority-filtered slope/ceiling/floor helpers previously
 * duplicated across BouncingKoopaBehavior, WingedGoombaBehavior, and
 * KoopaAppearance (see GitHub issue #229). The first two were deleted as
 * dead movement-simulation code in issue #409, so this bundle has no
 * production caller today; see docs/sprites/sprite-overlay-removal.md's
 * update section.
 *
 * Test tree:
 *   slopeAt      air / priority / flat-solid / slope-with-profile
 *   solidH       air / priority / wall / slope(no-wall)
 *   solidV       air / priority / floor / slope(floor=true)
 *   ceilingV     air / priority / solid($11-$6D) / slope($6E-$D7, ceiling=false) ← key invariant
 *   surfaceYAt   flat(row*16) / slope-adjusted / pxInTile clamping / &0x0F mask
 *   findFloorRowBelow  startRow-solid / stops-below / no-floor-null / slope-only-cell
 */

import { describe, it, expect } from 'vitest'
import { spriteCollisionFromL1 } from '../../../src/rom/model/sprites/SpriteCollision'
import { buildSolidity } from './fixtures/buildSolidity'
import type { GetL1Tile, L1Cell } from '../../../src/rom/model/OverlayContext'
import type { SlopeInfo } from '../../../src/rom/SlopeResolver'

// ── Synthetic cells ───────────────────────────────────────────────────────────

function cellAt(cell: L1Cell | null): GetL1Tile {
  return (c, r) => (c === 0 && r === 0 ? cell : null)
}

/** Returns the given cell at any (0, r) - for surfaceYAt tests that vary row. */
function colOf(cell: L1Cell | null): GetL1Tile {
  return (c, _r) => (c === 0 ? cell : null)
}

const MOCK_SLOPE: SlopeInfo = {
  slopeIndex: 0,
  heights: new Uint8Array([8, 7, 6, 5, 4, 3, 2, 1, 8, 7, 6, 5, 4, 3, 2, 1]),
}

/** Non-priority solid tile - actsLike page 1, low $30 ($11–$6D range). */
const FLAT_SOLID_CELL: L1Cell = {
  id: 0x200,
  actsLike: 0x130,
  collision: {
    floor: true,
    ceiling: true,
    wall: true,
    marioFloor: false,
    marioCeiling: false,
    marioWall: false,
    slopeTable: false,
  },
}

/** Priority-1 decorative - isPriority=true, all collision false. */
const PRIORITY_CELL: L1Cell = {
  id: 0x201,
  actsLike: 0x130,
  isPriority: true,
  collision: {
    floor: false,
    ceiling: false,
    wall: false,
    marioFloor: false,
    marioCeiling: false,
    marioWall: false,
    slopeTable: false,
  },
}

/** Non-priority slope tile - actsLike page 1, low $70 ($6E–$D7). floor=true, ceiling=false. */
const SLOPE_CELL: L1Cell = {
  id: 0x202,
  actsLike: 0x170,
  collision: {
    floor: true,
    ceiling: false,
    wall: false,
    marioFloor: false,
    marioCeiling: false,
    marioWall: false,
    slopeTable: true,
    slope: MOCK_SLOPE,
  },
}

/**
 * Synthetic slope cell where floor=false but slope is defined.
 * Not how real ROM tiles work (real slopes have floor=true), but lets us
 * exercise the explicit `slopeAt` branch of `findFloorRowBelow` in isolation.
 */
const SLOPE_ONLY_CELL: L1Cell = {
  id: 0x203,
  actsLike: 0x170,
  collision: {
    floor: false,
    ceiling: false,
    wall: false,
    marioFloor: false,
    marioCeiling: false,
    marioWall: false,
    slopeTable: true,
    slope: MOCK_SLOPE,
  },
}

// ── slopeAt ──────────────────────────────────────────────────────────────────

describe('slopeAt', () => {
  it('returns undefined for null (air) cell', () => {
    const { slopeAt } = spriteCollisionFromL1(() => null)
    expect(slopeAt(0, 0)).toBeUndefined()
  })

  it('returns undefined for priority-1 decorative cell', () => {
    const { slopeAt } = spriteCollisionFromL1(cellAt(PRIORITY_CELL))
    expect(slopeAt(0, 0)).toBeUndefined()
  })

  it('returns undefined for non-priority flat solid without slope profile', () => {
    const { slopeAt } = spriteCollisionFromL1(cellAt(FLAT_SOLID_CELL))
    expect(slopeAt(0, 0)).toBeUndefined()
  })

  it('returns SlopeInfo for non-priority slope tile with profile', () => {
    const { slopeAt } = spriteCollisionFromL1(cellAt(SLOPE_CELL))
    expect(slopeAt(0, 0)).toBe(MOCK_SLOPE)
  })
})

// ── solidH ───────────────────────────────────────────────────────────────────

describe('solidH', () => {
  it('returns false for air', () => {
    const { solidH } = spriteCollisionFromL1(() => null)
    expect(solidH(0, 0)).toBe(false)
  })

  it('returns false for priority cell', () => {
    const { solidH } = spriteCollisionFromL1(cellAt(PRIORITY_CELL))
    expect(solidH(0, 0)).toBe(false)
  })

  it('returns true for non-priority wall tile', () => {
    const { solidH } = spriteCollisionFromL1(cellAt(FLAT_SOLID_CELL))
    expect(solidH(0, 0)).toBe(true)
  })

  it('returns false for slope tile (wall=false for $6E–$D7 range)', () => {
    const { solidH } = spriteCollisionFromL1(cellAt(SLOPE_CELL))
    expect(solidH(0, 0)).toBe(false)
  })
})

// ── solidV ───────────────────────────────────────────────────────────────────

describe('solidV', () => {
  it('returns false for air', () => {
    const { solidV } = spriteCollisionFromL1(() => null)
    expect(solidV(0, 0)).toBe(false)
  })

  it('returns false for priority cell', () => {
    const { solidV } = spriteCollisionFromL1(cellAt(PRIORITY_CELL))
    expect(solidV(0, 0)).toBe(false)
  })

  it('returns true for non-priority flat solid', () => {
    const { solidV } = spriteCollisionFromL1(cellAt(FLAT_SOLID_CELL))
    expect(solidV(0, 0)).toBe(true)
  })

  it('returns true for slope tile (floor=true covers $6E–$D7 range)', () => {
    const { solidV } = spriteCollisionFromL1(cellAt(SLOPE_CELL))
    expect(solidV(0, 0)).toBe(true)
  })
})

// ── ceilingV ─────────────────────────────────────────────────────────────────

describe('ceilingV', () => {
  it('returns false for air', () => {
    const { ceilingV } = spriteCollisionFromL1(() => null)
    expect(ceilingV(0, 0)).toBe(false)
  })

  it('returns false for priority cell', () => {
    const { ceilingV } = spriteCollisionFromL1(cellAt(PRIORITY_CELL))
    expect(ceilingV(0, 0)).toBe(false)
  })

  it('returns true for non-priority solid in $11–$6D range', () => {
    const { ceilingV } = spriteCollisionFromL1(cellAt(FLAT_SOLID_CELL))
    expect(ceilingV(0, 0)).toBe(true)
  })

  it('CODE_0192C9 Y=3 invariant: slope tile ($6E–$D7) has ceiling=false', () => {
    // This is the exact invariant that fixed the ascending Para-Goomba glitch
    // in level $006 (PR #228). Using solidV here instead of ceilingV would
    // snap an ascending sprite DOWN below a rising slope.
    const { ceilingV } = spriteCollisionFromL1(cellAt(SLOPE_CELL))
    expect(ceilingV(0, 0)).toBe(false)
  })

  it('also verified via buildSolidity slope character', () => {
    // '/' maps to actsLike $170 (page-1 low $70 = slope range).
    // classifyForFixture → ceiling=false.
    const g = buildSolidity(['/'], { '/': { actsLike: 0x170 } })
    expect(g.collision.ceilingV(0, 0)).toBe(false)
    expect(g.collision.solidV(0, 0)).toBe(true) // floor=true for slope range
  })
})

// ── surfaceYAt ───────────────────────────────────────────────────────────────

describe('surfaceYAt', () => {
  it('returns row*16 for flat solid tile', () => {
    const { surfaceYAt } = spriteCollisionFromL1(cellAt(FLAT_SOLID_CELL))
    // centerX=8 → col=0 (FLAT_SOLID_CELL at col 0), row=3 → 48
    expect(surfaceYAt(8, 3)).toBe(48)
  })

  it('returns row*16 for air cell', () => {
    const { surfaceYAt } = spriteCollisionFromL1(() => null)
    expect(surfaceYAt(8, 2)).toBe(32)
  })

  it('returns slope-adjusted Y for slope tile at given centerX', () => {
    // colOf returns SLOPE_CELL at any row. centerX=8 → col=0, pxInTile=8.
    // heights[8]=8; surfaceY = 3*16 + (8 & 0x0F) = 48+8 = 56.
    const { surfaceYAt } = spriteCollisionFromL1(colOf(SLOPE_CELL))
    expect(surfaceYAt(8, 3)).toBe(48 + (MOCK_SLOPE.heights[8]! & 0x0f))
  })

  it('clamps pxInTile to 0 when centerX falls left of tile origin', () => {
    // centerX=0 → col=0, pxInTile = max(0, 0-0)=0. heights[0]=8.
    const { surfaceYAt } = spriteCollisionFromL1(cellAt(SLOPE_CELL))
    expect(surfaceYAt(0, 0)).toBe(0 + (MOCK_SLOPE.heights[0]! & 0x0f))
  })

  it('applies & 0x0F mask to heights entry', () => {
    // heights[0]=8; 8 & 0x0F = 8. Mask is a no-op here but verifies it runs.
    const { surfaceYAt } = spriteCollisionFromL1(cellAt(SLOPE_CELL))
    expect(surfaceYAt(0, 0)).toBe(MOCK_SLOPE.heights[0]! & 0x0f)
  })
})

// ── findFloorRowBelow ─────────────────────────────────────────────────────────

describe('findFloorRowBelow', () => {
  it('returns startRow when that row is already solid', () => {
    const g = buildSolidity(['#'], { '#': { actsLike: 0x130 } })
    expect(g.collision.findFloorRowBelow(0, 0, g.rows)).toBe(0)
  })

  it('returns the first solid row below startRow', () => {
    const g = buildSolidity(['.', '.', '#'], { '#': { actsLike: 0x130 } })
    // scan from row 0: rows 0 and 1 are air, row 2 is solid
    expect(g.collision.findFloorRowBelow(0, 0, g.rows)).toBe(2)
  })

  it('returns null when no floor exists within levelRows', () => {
    const g = buildSolidity(['.', '.', '.'])
    expect(g.collision.findFloorRowBelow(0, 0, g.rows)).toBeNull()
  })

  it('stops at slope-only cell (floor=false, slope defined) via slopeAt branch', () => {
    // Builds a getL1 where row 0 is air and row 1 has SLOPE_ONLY_CELL
    // (floor=false so solidV misses it, but slopeAt returns a SlopeInfo).
    const getL1: GetL1Tile = (c, r) => {
      if (c !== 0) return null
      if (r === 1) return SLOPE_ONLY_CELL
      return null
    }
    const collision = spriteCollisionFromL1(getL1)
    expect(collision.findFloorRowBelow(0, 0, 5)).toBe(1)
  })

  it('returns startRow when startRow equals levelRows (no rows to scan)', () => {
    const g = buildSolidity(['.'])
    // levelRows=1, startRow=1 → loop never runs → null
    expect(g.collision.findFloorRowBelow(0, 1, g.rows)).toBeNull()
  })
})
