/**
 * DryBonesAppearance.test.ts: branch coverage for fromTables.
 *
 * Test tree:
 *   fromTables()
 *     - faceRight=true  -> flipX=true, topDx=+8 (column order [1,0,3,2])
 *     - faceRight=false -> flipX=false, topDx=-8 (column order [0,1,2,3])
 */

import { describe, it, expect } from 'vitest'
import { DryBonesAppearance } from '../../../../src/rom/model/sprites/appearances/DryBonesAppearance'
import { Char } from '../../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'

function makePlaceholder(): Char {
  return new Char(0, new StaticPixelsBehavior(new Uint8Array(64)))
}

describe('DryBonesAppearance.fromTables - faceRight column order', () => {
  // Build a chars map where every tile ID maps to a distinct char so we can
  // identify which tile ended up where.
  function buildChars(base: number, charHigh: number): Map<number, Char> {
    const map = new Map<number, Char>()
    for (let i = 0; i < 0x200; i++) {
      map.set(base + charHigh + i, new Char(i, new StaticPixelsBehavior(new Uint8Array(64))))
    }
    return map
  }

  it('faceRight=true: first part uses offset 0x01 (right col first for flipX)', () => {
    const OBJ_BASE = 0x400
    const chars = buildChars(OBJ_BASE, 0)
    const app = DryBonesAppearance.fromTables(chars, makePlaceholder(), 9, 0, true)
    // Column order for flipX=true: [0x01, 0x00, 0x11, 0x10] (reversed columns)
    // bigTile(0x64, topDx, -16): first part has char = chars.get(OBJ_BASE + 0x65)
    const firstPart = app.parts[0]
    expect(firstPart.flipX).toBe(true)
    expect(firstPart.char.id).toBe(0x65) // 0x64 + 0x01
  })

  it('faceRight=false: first part uses offset 0x00 (left col first)', () => {
    const OBJ_BASE = 0x400
    const chars = buildChars(OBJ_BASE, 0)
    const app = DryBonesAppearance.fromTables(chars, makePlaceholder(), 9, 0, false)
    // Column order for flipX=false: [0x00, 0x01, 0x10, 0x11]
    // bigTile(0x64, topDx, -16): first part has char = chars.get(OBJ_BASE + 0x64)
    const firstPart = app.parts[0]
    expect(firstPart.flipX).toBe(false)
    expect(firstPart.char.id).toBe(0x64) // 0x64 + 0x00
  })
})
