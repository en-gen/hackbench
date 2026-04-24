/**
 * Tests for the pure functions in `src/rom/model/OverlayContext.ts` —
 * the acts-like solidity predicates and the priority-decorative filter
 * that together encode SMW's sprite-tile collision semantics.
 *
 * These functions are the foundation for every MovementBehavior's
 * collision query and for `SmwMap.renderSpriteOverlays`'s `GetL1Tile`
 * closure. Keeping the tests here (separate from any behavior) pins the
 * range semantics — $11..$6D solid (low-byte check), priority-1 quads
 * decorative, tileset 0 / 7 vertical solid window disabled.
 */

import { describe, expect, it } from 'vitest'
import {
  isActsLikeHorizSolid,
  isActsLikeVertSolid,
  isPriorityDecorative,
} from '../../../src/rom/model/OverlayContext'

describe('isActsLikeHorizSolid', () => {
  // Page-0 tiles ($000-$0FF) are decorative / slope / animated-foreground
  // in vanilla SMW convention and are never L1 walls. Only page-1+
  // actsLike values with low byte $11-$6D register as walls.
  it.each([
    [0x000, false],    // page 0, always passable
    [0x010, false],
    [0x011, false],    // page 0, even though low byte lands in range
    [0x06D, false],    // page 0, upper in-range low byte
    [0x100, false],    // page 1 low byte $00 — below $11
    [0x110, false],    // page 1 low byte $10 — below $11
    [0x111, true],     // page 1 solid lower inclusive
    [0x13F, true],
    [0x16D, true],     // page 1 solid upper inclusive
    [0x16E, false],    // page 1 slope low byte — not a wall
    [0x190, false],
    [0x1FF, false],
  ])('actsLike $%s → %s', (actsLike, expected) => {
    expect(isActsLikeHorizSolid(actsLike)).toBe(expected)
  })

  it.each([
    [0x130, true],    // low byte $30 (standard ground)
    [0x135, true],    // low byte $35 (yellow/blue pipe top)
    [0x168, true],    // low byte $68 (green pipe top)
    [0x16E, false],   // low byte $6E (slope, passthrough)
    [0x1FF, false],   // low byte $FF
  ])('page 1 id $%s → %s', (actsLike, expected) => {
    expect(isActsLikeHorizSolid(actsLike)).toBe(expected)
  })
})

describe('isActsLikeVertSolid', () => {
  // Same page-0 rejection as `isActsLikeHorizSolid` — decorative page-0
  // tiles aren't hard floors / ceilings even when low byte would match.
  it.each([
    [0x010, false],
    [0x011, false],   // page 0 low byte $11 — decorative
    [0x06D, false],   // page 0 low byte $6D
    [0x110, false],
    [0x111, true],    // page 1 solid lower
    [0x16D, true],    // page 1 solid upper
    [0x16E, false],   // page 1 slope — not vertically solid either
    [0x1C4, true],    // page 1 tileset-specific solid-from-above window
    [0x1C5, true],
    [0x1C9, true],    // window upper
    [0x1CA, false],   // window exceeded
  ])('default tileset: acts-like $%s → %s', (actsLike, expected) => {
    expect(isActsLikeVertSolid(actsLike)).toBe(expected)
  })

  it('tileset 0 (underground) disables the $C4..$C9 window', () => {
    expect(isActsLikeVertSolid(0x1C4, 0)).toBe(false)
    expect(isActsLikeVertSolid(0x1C7, 0)).toBe(false)
    expect(isActsLikeVertSolid(0x1C9, 0)).toBe(false)
    // But $11..$6D still solid for tileset 0.
    expect(isActsLikeVertSolid(0x130, 0)).toBe(true)
  })

  it('tileset 7 (ghost house) disables the $C4..$C9 window', () => {
    expect(isActsLikeVertSolid(0x1C4, 7)).toBe(false)
    expect(isActsLikeVertSolid(0x130, 7)).toBe(true)
  })

  it('tilesets 1-6 enable the window (default behavior)', () => {
    for (const ts of [1, 2, 3, 4, 5, 6]) {
      expect(isActsLikeVertSolid(0x1C7, ts)).toBe(true)
    }
  })
})

describe('isPriorityDecorative', () => {
  const priority = (p: boolean) => ({ priority: p })

  it('returns true when all four subtiles carry priority', () => {
    const tile = {
      behavior: { quad: [priority(true), priority(true), priority(true), priority(true)] },
    }
    expect(isPriorityDecorative(tile)).toBe(true)
  })

  it('returns false when any subtile lacks priority', () => {
    const mixed = [priority(true), priority(true), priority(false), priority(true)]
    expect(isPriorityDecorative({ behavior: { quad: mixed } })).toBe(false)
  })

  it('returns false for dynamic-behavior tiles (no stable quad)', () => {
    expect(isPriorityDecorative({ behavior: {} })).toBe(false)
  })

  it('returns false when quad length ≠ 4 (defensive)', () => {
    expect(isPriorityDecorative({ behavior: { quad: [] } })).toBe(false)
    expect(isPriorityDecorative({
      behavior: { quad: [priority(true), priority(true), priority(true)] },
    })).toBe(false)
  })

  it('returns false when all four subtiles are non-priority', () => {
    const nonPriority = [priority(false), priority(false), priority(false), priority(false)]
    expect(isPriorityDecorative({ behavior: { quad: nonPriority } })).toBe(false)
  })
})
