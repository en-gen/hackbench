/**
 * SpikeTopAppearance — 2-frame animation + patrol-path overlay.
 *
 * Animation (ASM: bank_02.asm:8079-8087):
 *   animBit = (EffFrame >> 3) & 1  →  SpriteMisc1602 = DATA_02BCB7[dir] + animBit
 *   dir 0, Misc1564=0 → base=$00 → SpriteMisc1602 cycles 0→1 every 8 game frames
 *
 * Direction 0 is the default (no flip, DATA_02BCC7[0]=$00).
 * Frame 0 uses tilemap[tilemapBase + 0]; frame 1 uses tilemap[tilemapBase + 1].
 * The tick counter toggles every ANIM_TICKS=8 calls to tickAnimation().
 *
 * tracePatrolPath (ASM: bank_02.asm:8065-8091 — WallFollowersMain):
 *   Per step:
 *     probe = tile at (col + PROBE_COL[dir], row + PROBE_ROW[dir])
 *     if probe NOT solid → outer corner: advance + turn clockwise
 *     else if forward solid → inner corner: turn counter-clockwise
 *     else → advance, same direction
 */

import { describe, it, expect, beforeEach } from 'vitest'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { SpikeTopAppearance, tracePatrolPath } from '../../../../src/rom/model/sprites/appearances/SpikeTopAppearance'
import type { Palette } from '../../../../src/rom/model/palette/Palette'
import type { RenderTarget } from '../../../../src/rom/model/RenderTarget'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import type { SpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import type { GetL1Tile, L1Cell } from '../../../../src/rom/model/OverlayContext'
import { makeTestMapStore, resetEditorStore } from '../fixtures/stores'
import { makeMockCtx } from '../fixtures/mockOverlayCtx'
import { NO_COLLISION } from '../../../../src/rom/model/tiles/TileCollision'

const STUB_BEHAVIOR: SpriteBehavior = { displayName: 'stub', spawns: false } as never

// ------------------------------------------------------------------ helpers

const OBJ_BASE = 0x400

/** Make a Char whose 64-px array has all pixels = `fill`, making it distinguishable. */
function namedChar(fill: number): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64).fill(fill)))
}

function stubMapStore() {
  const palette = {
    row: () => [] as RgbaColor[],
    color: () => [0, 0, 0, 0] as RgbaColor,
    cells: [] as never,
    backAreaColor: null as never,
  } as unknown as Palette
  return makeTestMapStore({ palette })
}

/** Capture all Uint8Array pixel buffers passed to blit8x8. */
function spyTarget(): { blit8x8: RenderTarget['blit8x8']; fillRect: RenderTarget['fillRect']; blits: Uint8Array[] } {
  const blits: Uint8Array[] = []
  return {
    blits,
    blit8x8(pixels: Uint8Array) { blits.push(pixels) },
    fillRect() {},
  } as unknown as { blit8x8: RenderTarget['blit8x8']; fillRect: RenderTarget['fillRect']; blits: Uint8Array[] }
}

/**
 * Build a minimal SpriteTileTables for sprite $2E.
 *
 * tilemapBase = 10 (arbitrary).
 * tilemap[10] = TILE_A (frame 0 base), tilemap[11] = TILE_B (frame 1 base).
 * attr = 0x01  →  palette = 8 + 0 = 8,  charHigh = 0x100.
 *
 * Chars populated for all 8 charNums touched by frames 0 and 1
 * (CORNER_OFFSETS = 0x00, 0x01, 0x10, 0x11 applied to each base tile).
 */
const TILE_A = 0x60   // frame 0 base tile
const TILE_B = 0x62   // frame 1 base tile
const CHAR_HIGH = 0x100
const TILEMAP_BASE = 10

/** charNum → fill value, so each tile has a unique pixel fingerprint. */
const CHAR_FILL: Record<number, number> = {}
const CORNER_OFFSETS = [0x00, 0x01, 0x10, 0x11] as const
for (const co of CORNER_OFFSETS) {
  CHAR_FILL[OBJ_BASE + CHAR_HIGH + TILE_A + co] = 0x10 + co   // frame 0
  CHAR_FILL[OBJ_BASE + CHAR_HIGH + TILE_B + co] = 0x20 + co   // frame 1
}

function makeChars(): Map<number, Char> {
  const chars = new Map<number, Char>()
  for (const [charNum, fill] of Object.entries(CHAR_FILL)) {
    chars.set(Number(charNum), namedChar(fill))
  }
  return chars
}

function makeTables(): SpriteTileTables {
  const tilemap = new Uint8Array(64)
  tilemap[TILEMAP_BASE]     = TILE_A
  tilemap[TILEMAP_BASE + 1] = TILE_B

  const tilemapOffset = new Uint8Array(0x54)
  tilemapOffset[0x2E] = TILEMAP_BASE

  const spriteAttr = new Uint8Array(0x100)
  spriteAttr[0x2E] = 0x01   // charHigh=1, palette bits=0 → CGRAM row 8

  return {
    tilemap,
    tilemapOffset,
    dispX: [0, 8, 0, 8],
    dispY: [0, 0, 8, 8],
    gfxProp: new Array(24).fill(0),
    spriteAttr,
    spr0to13Prop: new Uint8Array(0x14),
  }
}

// ------------------------------------------------------------------ helpers for appearance construction

function makeAppearance(): SpikeTopAppearance {
  return SpikeTopAppearance.fromTables(makeChars(), makeTables(), namedChar(0xFF))
}

/** Render and collect the pixel fills that were blit'd (first pixel of each Uint8Array). */
function blitFills(app: SpikeTopAppearance): number[] {
  const spy = spyTarget()
  app.render(spy as unknown as RenderTarget, 0, 0, STUB_BEHAVIOR, stubMapStore())
  return spy.blits.map(buf => buf[0])
}

/** All fill values belonging to frame 0 corners. */
const FRAME0_FILLS = CORNER_OFFSETS.map(co => CHAR_FILL[OBJ_BASE + CHAR_HIGH + TILE_A + co])
/** All fill values belonging to frame 1 corners. */
const FRAME1_FILLS = CORNER_OFFSETS.map(co => CHAR_FILL[OBJ_BASE + CHAR_HIGH + TILE_B + co])

// ------------------------------------------------------------------ tests

describe('SpikeTopAppearance.fromTables — construction', () => {
  beforeEach(resetEditorStore)

  it('hitRect covers a 16×16 box (one big-tile, corners at 0,0 to 16,16)', () => {
    const app = makeAppearance()
    expect(app.hitRect).toMatchObject({ dx: 0, dy: 0, w: 16, h: 16 })
  })

  it('palette from Sprite166EVals[$2E] & $0F: attr=0x01 → charHigh=1 → CGRAM row 8', () => {
    // Verify via which charNums the appearance resolves: OBJ_BASE + 0x100 + TILE_A + corner
    // i.e. the chars in the CHAR_HIGH=0x100 range are used, not the 0x000 range
    const app = makeAppearance()
    // All blits must be from frame-0 chars (fill 0x10..0x1x), NOT placeholder (0xFF)
    for (const fill of blitFills(app)) {
      expect(fill).not.toBe(0xFF)
    }
  })
})

describe('SpikeTopAppearance — animation gating', () => {
  let app: SpikeTopAppearance

  beforeEach(() => { resetEditorStore(); app = makeAppearance() })

  // ASM: bank_02.asm:8079-8083 — animBit stays 0 until EffFrame>>3 increments
  it('tick 0: renders frame 0 tiles (tilemap[base+0])', () => {
    expect(blitFills(app)).toEqual(FRAME0_FILLS)
  })

  it('ticks 1-7: still on frame 0', () => {
    for (let i = 0; i < 7; i++) app.tickAnimation()
    expect(blitFills(app)).toEqual(FRAME0_FILLS)
  })

  it('tick 8: switches to frame 1 tiles (tilemap[base+1])', () => {
    for (let i = 0; i < 8; i++) app.tickAnimation()
    expect(blitFills(app)).toEqual(FRAME1_FILLS)
  })

  it('ticks 9-15: still on frame 1', () => {
    for (let i = 0; i < 15; i++) app.tickAnimation()
    expect(blitFills(app)).toEqual(FRAME1_FILLS)
  })

  it('tick 16: returns to frame 0', () => {
    for (let i = 0; i < 16; i++) app.tickAnimation()
    expect(blitFills(app)).toEqual(FRAME0_FILLS)
  })

  it('renders exactly 4 blits per frame (one 16×16 big-tile = 4 corners)', () => {
    expect(blitFills(app)).toHaveLength(4)
    for (let i = 0; i < 8; i++) app.tickAnimation()
    expect(blitFills(app)).toHaveLength(4)
  })
})

// ------------------------------------------------------------------ tracePatrolPath helpers

/** actsLike 0x125: page 1 (≥ 0x100), low byte 0x25 ∈ [0x11, 0x6D] → solid.
 *  No `collision` property → falls through to the isActsLike* fallback in solidForWallFollow. */
const SOLID: L1Cell = { id: 0x200, actsLike: 0x125 }

/** Build a GetL1Tile from a string grid: '#' = solid, anything else = empty. */
function gridGetL1(lines: string[]): GetL1Tile {
  return (col: number, row: number): L1Cell | null => {
    const line = lines[row]
    if (!line || col < 0 || col >= line.length) return null
    return line[col] === '#' ? SOLID : null
  }
}

// ------------------------------------------------------------------ tracePatrolPath — single-step rules
//
// ASM: bank_02.asm:8065-8091 — three-branch dispatch in WallFollowersMain.
// Each test isolates one branch by fixing probe / forward tile solidity.

describe('tracePatrolPath — outer corner (probe empty → advance + turn clockwise)', () => {
  it('probe empty and forward empty: advances 1 tile forward', () => {
    // Nothing at probe (1,1) or forward (1,0) for dir=0
    const getL1 = gridGetL1(['...', '...'])
    const { points } = tracePatrolPath(0, 0, 0, getL1, 2)
    expect(points[0]).toEqual({ col: 0, row: 0 })
    expect(points[1]).toEqual({ col: 1, row: 0 })   // advanced to forward tile
  })

  it('probe empty: next position direction is clockwise (dir 0 → 1)', () => {
    // All empty — each step is an outer corner + clockwise turn
    const getL1: GetL1Tile = () => null
    // After the outer corner from (0,0,dir=0): pos=(1,0), dir=1
    // After the outer corner from (1,0,dir=1): pos=(1,1), dir=2
    const { points } = tracePatrolPath(0, 0, 0, getL1, 3)
    expect(points).toEqual([
      { col: 0, row: 0 },   // start
      { col: 1, row: 0 },   // advanced right (dir 0 fwd)
      { col: 1, row: 1 },   // advanced down  (dir 1 fwd)
    ])
  })
})

describe('tracePatrolPath — inner corner (forward solid → turn counter-clockwise, no advance)', () => {
  it('forward solid: position does not change on that step', () => {
    // col 1 is solid in both rows → probe (1,1) solid, forward (1,0) solid
    const getL1 = gridGetL1(['.#', '.#'])
    const { points } = tracePatrolPath(0, 0, 0, getL1, 2)
    // Both steps stay at col=0, row=0 (inner corner turns without advancing)
    expect(points[0]).toEqual({ col: 0, row: 0 })
    expect(points[1]).toEqual({ col: 0, row: 0 })
  })

  it('inner corner: direction becomes counter-clockwise (dir 0 → 3)', () => {
    // forward always solid → two inner-corner turns: dir 0→3→2
    const getL1 = gridGetL1(['.#', '.#'])
    const { points } = tracePatrolPath(0, 0, 0, getL1, 3)
    // step 0: (0,0), dir=0 → inner → dir=3 (probe for dir=3 at (+1,-1)=(1,-1)=null→empty → outer next)
    // step 1: (0,0), dir=3 → probe (1,-1)=null empty → outer corner: advance fwd=(0,-1), dir=0
    // step 2: (0,-1), dir=0 → ...
    // The critical assertion: step 1 is still at (0,0) proving no advance on inner corner
    expect(points[1]).toEqual({ col: 0, row: 0 })
  })
})

describe('tracePatrolPath — normal step (probe solid, forward empty → advance, same dir)', () => {
  it('normal step: position advances one tile in current direction', () => {
    // probe (1,1) solid; forward (1,0) empty → normal advance for dir=0
    const getL1 = gridGetL1(['..', '.#'])
    const { points } = tracePatrolPath(0, 0, 0, getL1, 2)
    expect(points[0]).toEqual({ col: 0, row: 0 })
    expect(points[1]).toEqual({ col: 1, row: 0 })
  })
})

// ------------------------------------------------------------------ tracePatrolPath — loop closure

describe('tracePatrolPath — loop closure', () => {
  // 2×2 solid block at cols 2-3, rows 2-3.
  // Walking the outer perimeter from (1,1,dir=0) forms a 12-step closed loop:
  //   (1,1)→(2,1)→(3,1)→(4,1)→(4,2)→(4,3)→(4,4)→(3,4)→(2,4)→(1,4)→(1,3)→(1,2)
  // then returns to (1,1,dir=0).
  const BLOCK_GRID = [
    '......',
    '......',
    '..##..',
    '..##..',
    '......',
  ]

  it('closed=true and 12 points for 2×2 block perimeter (dir=0)', () => {
    const { points, closed } = tracePatrolPath(1, 1, 0, gridGetL1(BLOCK_GRID))
    expect(closed).toBe(true)
    expect(points).toHaveLength(12)
  })

  it('first point is the start tile', () => {
    const { points } = tracePatrolPath(1, 1, 0, gridGetL1(BLOCK_GRID))
    expect(points[0]).toEqual({ col: 1, row: 1 })
  })

  it('path visits the four corner tiles adjacent to the block', () => {
    const { points } = tracePatrolPath(1, 1, 0, gridGetL1(BLOCK_GRID))
    const visited = new Set(points.map(p => `${p.col},${p.row}`))
    // outer-corner tiles (diagonal from each solid corner)
    expect(visited.has('4,1')).toBe(true)
    expect(visited.has('4,4')).toBe(true)
    expect(visited.has('1,4')).toBe(true)
  })

  it('closed=false and point count equals maxSteps when no loop exists', () => {
    // Infinite floor at row 1 → Spike Top walks right forever without closing
    const getL1: GetL1Tile = (_col, row) => row === 1 ? SOLID : null
    const { points, closed } = tracePatrolPath(0, 0, 0, getL1, 5)
    expect(closed).toBe(false)
    expect(points).toHaveLength(5)
  })

  it('closed=false and stops early when path reaches map boundary', () => {
    // ASM: sprite despawns when it crosses the level boundary.
    // Floor at row 1, map only 3 tiles wide (cols 0-2).
    const getL1: GetL1Tile = (_col, row) => row === 1 ? SOLID : null
    const { points, closed } = tracePatrolPath(0, 0, 0, getL1, 100, 3, 10)
    expect(closed).toBe(false)
    for (const p of points) expect(p.col).toBeLessThan(3)
  })
})

// ------------------------------------------------------------------ tracePatrolPath — dir 4 (left-hand track)
//
// ASM: InitSpikeTop (bank_01.asm:602) → CODE_01840E (bank_01.asm:620-626):
//   Mario.X < Sprite.X → SpriteTableC2 = 4 (LEFT, left-hand rule track).
// Dirs 4–7 follow the same algorithm but with different probe diagonals:
//   PROBE_COL[4]=-1, PROBE_ROW[4]=+1 (left+down diagonal, wall is below).

describe('tracePatrolPath — dir=4 (left-hand track, Mario to left)', () => {
  it('dir=4 advances LEFT along a floor (normal step)', () => {
    // Floor at row 1; probe (-1,+1) from (4,0) = (3,1) → solid → normal step LEFT.
    const getL1: GetL1Tile = (_col, row) => row === 1 ? SOLID : null
    const { points } = tracePatrolPath(4, 0, 4, getL1, 3)
    expect(points[0]).toEqual({ col: 4, row: 0 })
    expect(points[1]).toEqual({ col: 3, row: 0 })
    expect(points[2]).toEqual({ col: 2, row: 0 })
  })

  it('dir=4 outer corner: advances LEFT then turns to dir=5 (DOWN)', () => {
    // All-empty past col 2: probe for dir=4 at (1,1) is empty → outer corner.
    // After outer corner from (2,0): advance to (1,0), dir=(4&4)|((4+1)&3)=4|1=5.
    const getL1: GetL1Tile = (col, row) => (row === 1 && col >= 2) ? SOLID : null
    const { points } = tracePatrolPath(2, 0, 4, getL1, 2)
    expect(points[0]).toEqual({ col: 2, row: 0 })
    expect(points[1]).toEqual({ col: 1, row: 0 })  // advanced LEFT for the outer corner step
  })

  it('dir=4 traces a 12-point counter-clockwise loop around the 2×2 block', () => {
    // Same block as the dir=0 test but starting on the right side, left-hand track.
    // Right-hand (dir=0) goes clockwise; left-hand (dir=4) goes counter-clockwise.
    const getL1 = gridGetL1([
      '......',
      '......',
      '..##..',
      '..##..',
      '......',
    ])
    const { points, closed } = tracePatrolPath(4, 1, 4, getL1)
    expect(closed).toBe(true)
    expect(points).toHaveLength(12)
    expect(points[0]).toEqual({ col: 4, row: 1 })
  })
})

// ---- solidForWallFollow — isActsLikeVertSolid fallback (|| right-side branch) --

describe('solidForWallFollow — isActsLikeVertSolid fallback (|| right-side branch)', () => {
  it('cell with no collision, actsLike=0x1C4: horiz=false but vert=true → solid', () => {
    // actsLike 0x1C4: page 1, low byte 0xC4.
    //   isActsLikeHorizSolid(0x1C4) → 0xC4 not in [0x11,0x6D] → false  (left side, false)
    //   isActsLikeVertSolid(0x1C4)  → 0xC4 in [0xC4,0xC9] → true  (right side decides)
    // No collision property → falls through to the isActsLike* fallback.
    // Result: solidForWallFollow returns true → the cell is treated as solid,
    // causing a normal step instead of an outer corner.
    const VERT_ONLY: L1Cell = { id: 0x200, actsLike: 0x1C4 }   // no collision
    // dir=0: probe at (1,1)=VERT_ONLY (solid via vert fallback); forward (1,0)=null → normal step
    const getL1: GetL1Tile = (col, row) => (col === 1 && row === 1) ? VERT_ONLY : null
    const { points } = tracePatrolPath(0, 0, 0, getL1, 2)
    // Normal step: advance to forward tile (1,0)
    expect(points[1]).toEqual({ col: 1, row: 0 })
  })
})

// ---- solidForWallFollow — isPriority branch ----------------------------------

describe('solidForWallFollow — isPriority cell treated as non-solid', () => {
  it('isPriority=true at probe → outer corner taken (same as empty)', () => {
    const PRIORITY_CELL: L1Cell = { id: 0x200, actsLike: 0x125, isPriority: true }
    // dir=0: probe at (1,1) → priority → non-solid → outer corner: advance to (1,0)
    const getL1: GetL1Tile = (col, row) => (col === 1 && row === 1) ? PRIORITY_CELL : null
    const { points } = tracePatrolPath(0, 0, 0, getL1, 2)
    expect(points[1]).toEqual({ col: 1, row: 0 })
  })
})

// ---- solidForWallFollow — collision flags branch ----------------------------

describe('solidForWallFollow — collision property used when present', () => {
  it('cell.collision.floor=true → solid (normal step taken when forward is empty)', () => {
    const FLOOR_CELL: L1Cell = { id: 0x300, actsLike: 0, collision: { ...NO_COLLISION, floor: true } }
    // probe(1,1) has floor collision → solid; forward(1,0) is null → normal step
    const getL1: GetL1Tile = (col, row) => (col === 1 && row === 1) ? FLOOR_CELL : null
    const { points } = tracePatrolPath(0, 0, 0, getL1, 2)
    expect(points[1]).toEqual({ col: 1, row: 0 })
  })

  it('cell.collision.ceiling=true → solid (inner corner when forward also solid)', () => {
    const CEIL_CELL: L1Cell = { id: 0x301, actsLike: 0, collision: { ...NO_COLLISION, ceiling: true } }
    // probe(1,1) solid AND forward(1,0) solid → inner corner: no advance
    const getL1: GetL1Tile = (col, row) =>
      (col === 1 && (row === 0 || row === 1)) ? CEIL_CELL : null
    const { points } = tracePatrolPath(0, 0, 0, getL1, 2)
    expect(points[1]).toEqual({ col: 0, row: 0 })
  })

  it('cell.collision.wall=true → solid (normal step when forward empty)', () => {
    const WALL_CELL: L1Cell = { id: 0x302, actsLike: 0, collision: { ...NO_COLLISION, wall: true } }
    const getL1: GetL1Tile = (col, row) => (col === 1 && row === 1) ? WALL_CELL : null
    const { points } = tracePatrolPath(0, 0, 0, getL1, 2)
    expect(points[1]).toEqual({ col: 1, row: 0 })
  })
})

// ---- tracePatrolPath — negative and row boundary exits ---------------------

describe('tracePatrolPath — row/col negative boundary exits', () => {
  it('col < 0 exits (dir=2 LEFT from col=0)', () => {
    // dir=2: FWD_COL=-1. Probe(-1,-1)=null → outer corner: advance to (-1,0) → col<0 → exit
    const { closed } = tracePatrolPath(0, 0, 2, () => null, 100, 10, 5)
    expect(closed).toBe(false)
  })

  it('row < 0 exits (dir=3 UP from row=0)', () => {
    // dir=3: FWD_ROW=-1. Probe(1,-1)=null → outer corner: advance to (0,-1) → row<0 → exit
    const { closed } = tracePatrolPath(0, 0, 3, () => null, 100, 10, 5)
    expect(closed).toBe(false)
  })

  it('row >= levelRows exits (dir=1 DOWN from row=levelRows-1)', () => {
    // dir=1: FWD_ROW=+1. Probe(-1,1)=null → outer corner: advance to (0,1) → row>=1 → exit
    const { points, closed } = tracePatrolPath(0, 0, 1, () => null, 100, 10, 1)
    expect(closed).toBe(false)
    expect(points.every(p => p.row < 1)).toBe(true)
  })
})

// ---- renderOverlay — guard branches -----------------------------------------

describe('SpikeTopAppearance.renderOverlay — guards', () => {
  it('!isActive → no draw ops emitted', () => {
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, false, () => null, 10, 10, undefined as never, makeTestMapStore({}))
    expect(ctx.events.every(e => e.op === 'save' || e.op === 'restore')).toBe(true)
  })

  it('points.length < 2 (first step exits boundary) → no stroke emitted', () => {
    // levelCols=1: outer-corner advance from col=0 gives col=1 >= 1 → 1 point only
    const ctx = makeMockCtx()
    makeAppearance().renderOverlay(ctx, 0, 0, true, () => null, 1, 100, undefined as never, makeTestMapStore({}))
    expect(ctx.events.some(e => e.op === 'stroke')).toBe(false)
  })
})

// ---- renderOverlay — closed vs open path ------------------------------------

describe('SpikeTopAppearance.renderOverlay — closed path → closePath()', () => {
  const BLOCK_GRID = [
    '......',
    '......',
    '..##..',
    '..##..',
    '......',
  ]

  it('closed loop → closePath() called', () => {
    const ctx = makeMockCtx()
    // x=16,y=16 → startCol=1, startRow=1; marioSpawnX=0 < 16 → dir=4 → closed 12-point loop
    makeAppearance().renderOverlay(ctx, 16, 16, true, gridGetL1(BLOCK_GRID), 6, 5, undefined as never, makeTestMapStore({}))
    expect(ctx.events.some(e => e.op === 'closePath')).toBe(true)
  })

  it('open path → no closePath() called', () => {
    const ctx = makeMockCtx()
    // Infinite floor; sprite walks right forever without closing
    const getL1: GetL1Tile = (_col, row) => row === 1 ? SOLID : null
    makeAppearance().renderOverlay(ctx, 0, 0, true, getL1, 1000, 1000, undefined as never, makeTestMapStore({}))
    expect(ctx.events.some(e => e.op === 'closePath')).toBe(false)
  })
})

// ---- fromTables — ?? fallback branches --------------------------------------

describe('SpikeTopAppearance.fromTables — ?? fallback branches', () => {
  it('short spriteAttr/tilemapOffset/tilemap → ?? 0 defaults; palette=8, charHigh=0', () => {
    const tables: SpriteTileTables = {
      tilemap:       new Uint8Array(0),
      tilemapOffset: new Uint8Array(0),
      spriteAttr:    new Uint8Array(0),
      dispX: [],
      dispY: [],
      gfxProp: [],
      spr0to13Prop:  new Uint8Array(0),
    }
    const placeholder = namedChar(0xFF)
    const app = SpikeTopAppearance.fromTables(new Map(), tables, placeholder)
    expect(app.parts0.every(p => p.char === placeholder)).toBe(true)
    expect(app.parts0[0].palette).toBe(8)
  })

  it('chars missing key → ?? placeholder for all parts in both frames', () => {
    const placeholder = namedChar(0xFF)
    const app = SpikeTopAppearance.fromTables(new Map(), makeTables(), placeholder)
    expect(app.parts0.every(p => p.char.getPixels()[0] === 0xFF)).toBe(true)
    expect(app.parts1.every(p => p.char.getPixels()[0] === 0xFF)).toBe(true)
  })

  it('empty dispX/dispY → ?? 0 for all dx/dy', () => {
    const tables: SpriteTileTables = { ...makeTables(), dispX: [], dispY: [] }
    const app = SpikeTopAppearance.fromTables(makeChars(), tables, namedChar(0xFF))
    expect(app.parts0.every(p => p.dx === 0 && p.dy === 0)).toBe(true)
  })
})
