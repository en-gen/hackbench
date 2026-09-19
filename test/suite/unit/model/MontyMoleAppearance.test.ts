/**
 * MontyMoleAppearance - sprite $4D two-frame SubSprGfx0 pose.
 *
 * $4D's only drawing state is state 1 of the SpriteTableC2 jump table,
 * CODE_01E343 (bank_01.asm:13388-13403). `SubSprGfx0Entry0` resolves the
 * tile quad as `SprTilemapOffset[$4D] + (SpriteMisc1602 << 2)`
 * (bank_01.asm:3865-3869), so the two frames read DISJOINT 4-byte
 * windows. The pre-fix generic sub0 builder pinned SpriteMisc1602 = 0 and
 * read the quad four bytes below frame 0 - which for $4D is the sprite's
 * SubSprGfx2 single-tile frame list, not a pose.
 *
 * The full ASM walk, table values and measured evidence scopes are in
 * docs/sprite-4d-monty-mole.md; this file cites lines, it does not
 * restate the routines.
 *
 * Test tree
 * ─────────
 *   ROM-derived constants
 *     - MOLE_TILE_FRAMES / MOLE_PROP_GROUPS / ANIM_ROM_FRAMES
 *     - ROM_FRAMES_PER_TICK tracks the shared SPRITE_ANIM_INTERVAL_MS
 *   fromTables (synthetic tables)
 *     - frame 0 reads tilemap[base + 1*4 + corner]
 *     - frame 1 reads tilemap[base + 2*4 + corner]
 *     - frame 0 takes flips from gfxProp group 0, frame 1 from group 5
 *     - corner positions come from GeneralSprDispX/Y
 *     - palette and char-high come from the sprite attr
 *   fromParts
 *     - both frames share the array (used by $4E)
 *   tickAnimation / render
 *     - the toggle rate is wall-clock correct (16 game frames, not 16 ticks)
 *   renderAboveL1 (the emerged-pose ghost annotation)
 *     - emerged parts come from SprTilemap[base + EMERGED_MISC1602],
 *       expanded as a 16x16 big tile
 *     - drawn EMERGED_DY above the anchor, at EMERGED_ALPHA
 *     - static: unaffected by tickAnimation, and never the mound quads
 *     - $4E (fromParts) gets no annotation
 *     - INSIDE hitRect: clicking the ghost picks the sprite
 *   vanilla ROM (skipped when test/roms/ is absent)
 *     - the emerged frame is SprTilemap[base + $02] and is none of the
 *       other three SubSprGfx2 frames nor either mound quad
 *     - the emerged composite is mirror-symmetric in sprite set 5 ONLY;
 *       the sweep over all 16 sets pins which ones it is not
 *     - both frames match the bytes at the derived offsets
 *     - the two frames are a mirror pair, and neither equals the
 *       SpriteMisc1602 = 0 quad the generic builder used to read
 *
 * Tests marked DATA PIN read both sides of the comparison from the ROM.
 * They cannot go red on a code defect - they lock ROM table shape so a
 * hack ROM or a table-reader change is noticed. They are not oracles.
 */

import { existsSync } from 'fs'
import { resolve } from 'path'
import { describe, expect, it } from 'vitest'
import { Char } from '../../../../src/rom/model/chars/Char'
import {
  ANIM_CYCLE_ROM_FRAMES,
  ANIM_ROM_FRAMES,
  EMERGED_ALPHA,
  EMERGED_DY,
  EMERGED_MISC1602,
  MOLE_PROP_GROUPS,
  MOLE_TILE_FRAMES,
  MontyMoleAppearance,
  ROM_FRAMES_PER_TICK,
} from '../../../../src/rom/model/sprites/appearances/MontyMoleAppearance'
import { SPRITE_ANIM_FRAME_STRIDE } from '../../../../src/rom/timing'
import { Sprite } from '../../../../src/rom/model/sprites/Sprite'
import type { SpriteBehavior } from '../../../../src/rom/model/sprites/SpriteBehavior'
import type { SpritePart } from '../../../../src/rom/model/sprites/appearances/StaticSpriteAppearance'
import type { RenderTarget } from '../../../../src/rom/model/RenderTarget'
import { readSpriteTileTables, type SpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import { getCharPixels, loadVram } from '../../../../src/rom/GfxLoader'
import { parseLevelHeader, parseLevelSprites } from '../../../../src/rom/LevelParser'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildSprites } from '../../../../src/rom/model/SpriteFactory'
import type { LevelSprite } from '../../../../src/rom/LevelParser'
import type { Tile } from '../../../../src/rom/model/tiles/Tile'
import type { MapStore } from '../../../../src/rom/model/stores/mapStore'

const OBJ_BASE = 0x400
const MOLE     = 0x4D

function syntheticChar(id: number): Char {
  // One stable buffer per char, so a render sniffer can map the blitted
  // pixels back to the char id by buffer identity.
  const pixels = new Uint8Array(64).fill(id & 0xFF)
  return new Char(id, { getPixels: () => pixels })
}
const placeholder = syntheticChar(-1)

function buildChars(): Map<number, Char> {
  const map = new Map<number, Char>()
  for (let id = 0; id < 0x800; id++) map.set(id, syntheticChar(id))
  return map
}

/** GeneralSprGfxProp, bank_01.asm:3848-3850 - 6 groups × 4 corners. */
const GFX_PROP = [
  0x00, 0x00, 0x00, 0x00,
  0x00, 0x40, 0x00, 0x40,
  0x00, 0x40, 0x80, 0xC0,
  0x40, 0x40, 0x00, 0x00,
  0x40, 0x00, 0xC0, 0x80,
  0x40, 0x40, 0x40, 0x40,
]

function makeTables(overrides: Partial<SpriteTileTables> = {}): SpriteTileTables {
  return {
    tilemap:       new Uint8Array(0xFC),
    tilemapOffset: new Uint8Array(0x54),
    dispX:         [0, 8, 0, 8],
    dispY:         [0, 0, 8, 8],
    gfxProp:       GFX_PROP,
    spriteAttr:    new Uint8Array(0x100),
    spr0to13Prop:  new Uint8Array(0x14),
    ...overrides,
  }
}

/** Synthetic tables where every tilemap byte equals its own index. */
function identityTables(base: number, attr = 0): SpriteTileTables {
  const tilemap = new Uint8Array(0xFC)
  for (let i = 0; i < tilemap.length; i++) tilemap[i] = i
  const tilemapOffset = new Uint8Array(0x54)
  tilemapOffset[MOLE] = base
  const spriteAttr = new Uint8Array(0x100)
  spriteAttr[MOLE] = attr
  return makeTables({ tilemap, tilemapOffset, spriteAttr })
}

const chars = buildChars()

// Minimal palette-like object; only .row() is called in render paths.
const MOCK_MAP_STORE = { palette: { row: (_n: number) => new Array(16) } } as unknown as MapStore

describe('MontyMoleAppearance - ROM-derived constants', () => {
  it('MOLE_TILE_FRAMES is DATA_01E35F (bank_01.asm:13407)', () => {
    expect([...MOLE_TILE_FRAMES]).toEqual([0x01, 0x02])
  })

  it('MOLE_PROP_GROUPS is DATA_01E361 (bank_01.asm:13410)', () => {
    expect([...MOLE_PROP_GROUPS]).toEqual([0x00, 0x05])
  })

  it('ANIM_ROM_FRAMES is 16 GAME frames - EffFrame >> 4 & 1 (bank_01.asm:13392-13397)', () => {
    expect(ANIM_ROM_FRAMES).toBe(16)
    expect(ANIM_CYCLE_ROM_FRAMES).toBe(32)
  })

  it('ROM_FRAMES_PER_TICK tracks the shared editor cadence, it is not a loose 8', () => {
    // The point is the COUPLING: retuning the stride must move this
    // constant, or the mole animates at the old rate with every test
    // green. Asserting `toBe(8)` alone would only restate the literal.
    expect(ROM_FRAMES_PER_TICK).toBe(SPRITE_ANIM_FRAME_STRIDE)
    // ...and the stride itself is pinned, so a retune is a deliberate
    // edit to a test, not a silent one. 8 frames is SetAnimationFrame's
    // per-frame counter, SMWDisX bank_01.asm:2089-2096.
    expect(SPRITE_ANIM_FRAME_STRIDE).toBe(8)
  })

  it('is a whole number of game frames, so the accumulator cannot drift', () => {
    // Was 7.5, back-derived from an uncited 125 ms editor interval, with a
    // sibling spelling that evaluated to 7.499999999999999. A whole stride
    // removes that problem rather than bounding it.
    expect(Number.isInteger(ROM_FRAMES_PER_TICK)).toBe(true)
  })
})

describe('MontyMoleAppearance.fromTables - tile-quad selection', () => {
  const BASE = 0x20

  it('frame 0 reads the quad at base + SpriteMisc1602($01) * 4', () => {
    const a = MontyMoleAppearance.fromTables(chars, identityTables(BASE), placeholder)
    // identity tilemap → char id = OBJ_BASE + tilemap index
    expect(a.parts0.map(p => p.char.id)).toEqual([
      OBJ_BASE + BASE + 4, OBJ_BASE + BASE + 5, OBJ_BASE + BASE + 6, OBJ_BASE + BASE + 7,
    ])
  })

  it('frame 1 reads the quad at base + SpriteMisc1602($02) * 4', () => {
    const a = MontyMoleAppearance.fromTables(chars, identityTables(BASE), placeholder)
    expect(a.parts1.map(p => p.char.id)).toEqual([
      OBJ_BASE + BASE + 8, OBJ_BASE + BASE + 9, OBJ_BASE + BASE + 10, OBJ_BASE + BASE + 11,
    ])
  })

  it('neither frame reads the SpriteMisc1602 = 0 quad', () => {
    // The pre-fix defect: the generic sub0 builder read base + 0..3.
    const a = MontyMoleAppearance.fromTables(chars, identityTables(BASE), placeholder)
    const stale = [BASE, BASE + 1, BASE + 2, BASE + 3].map(i => OBJ_BASE + i)
    expect(a.parts0.map(p => p.char.id)).not.toEqual(stale)
    expect(a.parts1.map(p => p.char.id)).not.toEqual(stale)
  })
})

describe('MontyMoleAppearance.fromTables - flip-quad selection', () => {
  it('frame 0 uses GeneralSprGfxProp group 0 (no flips)', () => {
    const a = MontyMoleAppearance.fromTables(chars, identityTables(0x20), placeholder)
    expect(a.parts0.map(p => p.flipX)).toEqual([false, false, false, false])
    expect(a.parts0.map(p => p.flipY)).toEqual([false, false, false, false])
  })

  it('frame 1 uses GeneralSprGfxProp group 5 (all H-flipped)', () => {
    const a = MontyMoleAppearance.fromTables(chars, identityTables(0x20), placeholder)
    expect(a.parts1.map(p => p.flipX)).toEqual([true, true, true, true])
    expect(a.parts1.map(p => p.flipY)).toEqual([false, false, false, false])
  })
})

describe('MontyMoleAppearance.fromTables - layout and attribute', () => {
  it('places corners per GeneralSprDispX/Y', () => {
    const a = MontyMoleAppearance.fromTables(chars, identityTables(0x20), placeholder)
    for (const frame of [a.parts0, a.parts1]) {
      expect(frame.map(p => [p.dx, p.dy])).toEqual([[0, 0], [8, 0], [0, 8], [8, 8]])
    }
  })

  it('derives palette from attr bits 3-1 and char-high from bit 0', () => {
    // attr $0D → palette row 8 + ((0x0D >> 1) & 7) = 14, char-high = $100.
    const a = MontyMoleAppearance.fromTables(chars, identityTables(0x20, 0x0D), placeholder)
    expect(a.parts0.every(p => p.palette === 14)).toBe(true)
    expect(a.parts0[0].char.id).toBe(OBJ_BASE + 0x100 + 0x24)
  })

  it('falls back to the placeholder char when the sheet lacks the char', () => {
    const a = MontyMoleAppearance.fromTables(new Map(), identityTables(0x20), placeholder)
    expect(a.parts0.every(p => p.char === placeholder)).toBe(true)
  })

  it('hitRect spans the mound AND the lifted ghost', () => {
    const a = MontyMoleAppearance.fromTables(chars, identityTables(0x20), placeholder)
    expect(a.hitRect).toEqual({ dx: 0, dy: -16, w: 16, h: 32 })
  })
})

describe('MontyMoleAppearance.fromParts', () => {
  it('gives $4E a single pose shared by both frames', () => {
    const parts: SpritePart[] = [
      { char: syntheticChar(1), palette: 8, flipX: false, flipY: false, dx: 0, dy: 0 },
    ]
    const a = MontyMoleAppearance.fromParts(parts)
    expect(a.parts0).toBe(parts)
    expect(a.parts1).toBe(parts)
  })
})

describe('MontyMoleAppearance.tickAnimation - cadence', () => {
  // The two frames differ in flipX (group 0 = none, group 5 = all), so the
  // flag the first blit receives identifies which frame render() picked.
  function activeFrame(a: MontyMoleAppearance): 0 | 1 {
    let flipped = false
    let first   = true
    const sniff: RenderTarget = {
      blit8x8: (_pixels, _pos, _row, flipX) => { if (first) { flipped = flipX; first = false } },
      fillRect: () => {},
    }
    a.render(sniff, 0, 0, undefined as never, MOCK_MAP_STORE)
    return flipped ? 1 : 0
  }

  function newMole(): MontyMoleAppearance {
    return MontyMoleAppearance.fromTables(chars, identityTables(0x20), placeholder)
  }

  it('flips on the 2nd tick, not the 16th - a tick is 8 game frames', () => {
    // 16 game frames / 8 game frames per tick = exactly 2 ticks, so the
    // 2nd tick is the first that crosses the EffFrame bit-4 boundary.
    // Counting raw ticks against 16 (the pre-fix bug) would hold frame 0
    // until the 16th tick. At the old 7.5 it was the 3rd tick.
    const a = newMole()
    expect(activeFrame(a)).toBe(0)
    a.tickAnimation(); expect(activeFrame(a)).toBe(0)   // 8 game frames
    a.tickAnimation(); expect(activeFrame(a)).toBe(1)   // 16 → bit 4 set
    a.tickAnimation(); expect(activeFrame(a)).toBe(1)   // 24
  })

  it('toggles at exactly the wall-clock rate the ROM does', () => {
    // Externals, not internals. The ROM holds each pose 16 game frames;
    // the editor tick is 8, so a toggle every 2 ticks, and 2 ticks is
    // 16/60.098 = 266.2 ms, the ROM's own hold. The rate is now equal
    // rather than approximated, so this is an equality, not a window.
    // The pre-fix code managed 240/16 = 15 toggles.
    const TICKS = 240
    const a = newMole()
    let prev   = activeFrame(a)
    let toggles = 0
    for (let i = 0; i < TICKS; i++) {
      a.tickAnimation()
      const cur = activeFrame(a)
      if (cur !== prev) { toggles++; prev = cur }
    }
    expect(toggles).toBe(TICKS / 2)
  })

  it('holds a pinned pose sequence, period 4 ticks', () => {
    // A LITERAL sequence, because the obvious formulations do not
    // discriminate: comparing ticks 0-63 against 64-127 passes for any
    // step whose period divides 64. romFrame is (romFrame + 8) % 32 and
    // the pose is bit 4, so ticks 1.. run 0,1,1,0 and repeat.
    //
    // This sequence IS cadence-sensitive: at the old 7.5 it was
    // '0011001100110011100110011001100111001100', and a stride of 4 or
    // 16 gives a different period again.
    const EXPECTED = '0110'.repeat(10)
    const a = newMole()
    let got = ''
    for (let i = 0; i < EXPECTED.length; i++) { a.tickAnimation(); got += activeFrame(a) }
    expect(got).toBe(EXPECTED)
  })

  it('renders one blit per part', () => {
    const a = newMole()
    let count = 0
    const target: RenderTarget = { blit8x8: () => { count++ }, fillRect: () => {} }
    a.render(target, 0, 0, undefined as never, MOCK_MAP_STORE)
    expect(count).toBe(4)
  })
})

// ── renderAboveL1: the emerged-pose ghost annotation ────────────────────────

interface SniffedBlit { x: number; y: number; charId: number; alpha: number | undefined }

function sniffBlits(
  draw: (t: RenderTarget) => void,
  charOf: (pixels: Uint8Array) => number,
): SniffedBlit[] {
  const out: SniffedBlit[] = []
  const target: RenderTarget = {
    blit8x8: (pixels, pos, _row, _flipX, _flipY, alpha) => {
      out.push({ x: pos.x, y: pos.y, charId: charOf(pixels), alpha })
    },
    fillRect: () => {},
  }
  draw(target)
  return out
}

describe('MontyMoleAppearance - emerged-pose constants', () => {
  it('EMERGED_MISC1602 is $02 - state 2, CODE_01E37F (bank_01.asm:13426)', () => {
    // $02 is the front-facing pose the user picked from the four rendered
    // SubSprGfx2 frames. Spelled out, not read back from the appearance.
    expect(EMERGED_MISC1602).toBe(0x02)
  })

  it('EMERGED_DY lifts the ghost one full sprite height clear of the mound', () => {
    expect(EMERGED_DY).toBe(-16)
  })

  it('EMERGED_ALPHA matches the editor ghost convention (0.5)', () => {
    expect(EMERGED_ALPHA).toBe(0.5)
  })
})

describe('MontyMoleAppearance.renderAboveL1', () => {
  // syntheticChar hands out one stable buffer per char, so a render sniffer
  // maps the blitted pixels back to the char id by buffer identity.
  function charLookup(a: MontyMoleAppearance): (p: Uint8Array) => number {
    const byBuf = new Map<Uint8Array, number>()
    for (const part of [...a.parts0, ...a.parts1, ...a.emergedParts]) {
      byBuf.set(part.char.getPixels(), part.char.id)
    }
    return p => byBuf.get(p) ?? -1
  }

  function newMole(base = 0x20): MontyMoleAppearance {
    return MontyMoleAppearance.fromTables(chars, identityTables(base), placeholder)
  }

  it('reads the single SubSprGfx2 byte at base + EMERGED_MISC1602', () => {
    // identity tilemap: SprTilemap[i] === i, so the frame number is
    // base + EMERGED_MISC1602 and the 16x16 expands to N, N+1, N+$10, N+$11.
    const BASE = 0x20
    const a = newMole(BASE)
    const tile = BASE + EMERGED_MISC1602
    expect(a.emergedParts.map(p => p.char.id)).toEqual([
      OBJ_BASE + tile, OBJ_BASE + tile + 1, OBJ_BASE + tile + 0x10, OBJ_BASE + tile + 0x11,
    ])
    expect(a.emergedParts.map(p => [p.dx, p.dy])).toEqual([[0, 0], [8, 0], [0, 8], [8, 8]])
  })

  it('is NOT one of the mound quads - a wrong source would land on $CE/$88/$89', () => {
    const BASE = 0x20
    const a = newMole(BASE)
    const emerged = a.emergedParts.map(p => p.char.id)
    expect(emerged).not.toEqual(a.parts0.map(p => p.char.id))
    expect(emerged).not.toEqual(a.parts1.map(p => p.char.id))
    // Nor either of the other two SubSprGfx2 frames.
    for (const wrong of [0x00, 0x01, 0x03]) {
      const t = BASE + wrong
      expect(emerged).not.toEqual([t, t + 1, t + 0x10, t + 0x11].map(n => OBJ_BASE + n))
    }
  })

  it('shares the mound palette and char-high - same SpriteOBJAttribute byte', () => {
    // attr $0D → palette 8 + ((0x0D >> 1) & 7) = 14, char-high $100.
    const a = MontyMoleAppearance.fromTables(chars, identityTables(0x20, 0x0D), placeholder)
    expect(a.emergedParts.every(p => p.palette === 14)).toBe(true)
    expect(a.emergedParts[0].char.id).toBe(OBJ_BASE + 0x100 + 0x20 + EMERGED_MISC1602)
  })

  it('draws one sprite height above the anchor, ghosted', () => {
    // Coordinates spelled out, NOT recomputed from EMERGED_DY - reading the
    // constant back out of the module under test would make this pass for
    // any offset, including 0.
    const a  = newMole()
    const ix = charLookup(a)
    const at = sniffBlits(t => a.renderAboveL1(t, 64, 96, undefined as never, MOCK_MAP_STORE), ix)
    expect(at.map(b => [b.x, b.y])).toEqual([[64, 80], [72, 80], [64, 88], [72, 88]])
    expect(at.map(b => b.charId)).toEqual(a.emergedParts.map(p => p.char.id))
  })

  it('never overlaps the in-place render - the mound stays readable', () => {
    // Behavioural form of "the ghost is offset": the two passes must not
    // write the same pixel rows. An offset of 0 collapses this.
    const a  = newMole()
    const ix = charLookup(a)
    const below = sniffBlits(t => a.render(t, 64, 96, undefined as never, MOCK_MAP_STORE), ix)
    const above = sniffBlits(t => a.renderAboveL1(t, 64, 96, undefined as never, MOCK_MAP_STORE), ix)
    const rows = new Set(below.map(b => b.y))
    expect(above.some(b => rows.has(b.y))).toBe(false)
    // and above, not below
    expect(Math.max(...above.map(b => b.y))).toBeLessThan(Math.min(...below.map(b => b.y)))
  })

  it('is ghosted - every blit is strictly between invisible and opaque', () => {
    // Both ends matter. Full alpha makes the annotation read as a second
    // real sprite; zero alpha makes it silently do nothing. The literal
    // 0.5 is spelled out rather than read from EMERGED_ALPHA, so changing
    // the constant moves this expectation.
    const a  = newMole()
    const ix = charLookup(a)
    const at = sniffBlits(t => a.renderAboveL1(t, 0, 0, undefined as never, MOCK_MAP_STORE), ix)
    expect(at).toHaveLength(4)
    for (const b of at) {
      expect(b.alpha).toBeGreaterThan(0)
      expect(b.alpha).toBeLessThan(1)
      expect(b.alpha).toBe(0.5)
    }
  })

  it('is static - the annotation does not follow the mound animation', () => {
    const a  = newMole()
    const ix = charLookup(a)
    const before = sniffBlits(t => a.renderAboveL1(t, 0, 0, undefined as never, MOCK_MAP_STORE), ix)
    for (let i = 0; i < 40; i++) {
      a.tickAnimation()
      expect(sniffBlits(t => a.renderAboveL1(t, 0, 0, undefined as never, MOCK_MAP_STORE), ix))
        .toEqual(before)
    }
  })

  it('leaves the in-place render untouched - the rubble is still drawn at the anchor', () => {
    const a  = newMole()
    const ix = charLookup(a)
    const at = sniffBlits(t => a.render(t, 64, 96, undefined as never, MOCK_MAP_STORE), ix)
    expect(at.map(b => [b.x, b.y])).toEqual([[64, 96], [72, 96], [64, 104], [72, 104]])
    expect(at.map(b => b.charId)).toEqual(a.parts0.map(p => p.char.id))
    expect(at.every(b => b.alpha === undefined)).toBe(true)
  })

  it('$4E (fromParts) gets no annotation - its resting pose is modelled wrong', () => {
    const a = MontyMoleAppearance.fromParts(
      [{ char: syntheticChar(1), palette: 8, flipX: false, flipY: false, dx: 0, dy: 0 }],
    )
    expect(a.emergedParts).toEqual([])
    let blits = 0
    a.renderAboveL1(
      { blit8x8: () => { blits++ }, fillRect: () => {} },
      0, 0, undefined as never, MOCK_MAP_STORE,
    )
    expect(blits).toBe(0)
  })

  it('clicking the ghost picks THE SPRITE, not the L1 tile behind it', () => {
    // The reported symptom: level $010, mole at tile (12,23). The mound is
    // anonymous dirt and the ghost is the only recognisable mole artwork,
    // so a click at (12,22) used to fall through to `L1 $xyz`.
    const mole = new Sprite(
      MOLE, 12 * 16, 23 * 16, newMole(), { kind: 'stub' } as unknown as SpriteBehavior,
    )
    // Ghost row: one tile above the anchor.
    expect(mole.pickAt(12 * 16 + 8, 22 * 16 + 8)).toBe(mole)
    // Mound row still picks, and it is the SAME sprite - the ghost is an
    // annotation, not a second selectable object.
    expect(mole.pickAt(12 * 16 + 8, 23 * 16 + 8)).toBe(mole)
    // One row above the ghost is still a miss: the rect grew by exactly
    // the annotation, not unboundedly.
    expect(mole.pickAt(12 * 16 + 8, 21 * 16 + 8)).toBeNull()
  })

  it('$4E, with no annotation, keeps the plain 16x16 hit rect', () => {
    const a = MontyMoleAppearance.fromParts(
      [{ char: syntheticChar(1), palette: 8, flipX: false, flipY: false, dx: 0, dy: 0 }],
    )
    expect(a.hitRect).toEqual({ dx: 0, dy: 0, w: 8, h: 8 })
  })
})

// ── vanilla ROM ──────────────────────────────────────────────────────────────

const ROM_PATH   = resolve(__dirname, '../../../roms/Super Mario World (USA).vanilla.sfc')
const romPresent = existsSync(ROM_PATH)

describe.skipIf(!romPresent)('MontyMoleAppearance - vanilla ROM (ROM-only)', () => {
  function romTables(): SpriteTileTables {
    const tables = readSpriteTileTables(SmwRom.open(ROM_PATH).rom)
    expect(tables).not.toBeNull()
    return tables!
  }

  it('DATA PIN: frame chars equal SprTilemap at the two derived quads', () => {
    // Both sides come from the ROM, so this cannot go red on a rendering
    // defect. It locks the offsets the reader derives against the table.
    const tables = romTables()
    const base   = tables.tilemapOffset[MOLE]
    const attr   = tables.spriteAttr[MOLE]
    const high   = (attr & 0x01) !== 0 ? 0x100 : 0

    // Expectations are READ FROM THE ROM at the offsets the ASM derives:
    //   frame 0 → base + $01*4, frame 1 → base + $02*4  (DATA_01E35F).
    const quad = (animFrame: number): number[] =>
      [0, 1, 2, 3].map(c => OBJ_BASE + high + tables.tilemap[base + animFrame * 4 + c])

    const a = MontyMoleAppearance.fromTables(buildChars(), tables, placeholder)
    expect(a.parts0.map(p => p.char.id)).toEqual(quad(0x01))
    expect(a.parts1.map(p => p.char.id)).toEqual(quad(0x02))
  })

  it('DATA PIN: frame flips equal GeneralSprGfxProp groups 0 and 5', () => {
    const tables = romTables()
    const a = MontyMoleAppearance.fromTables(buildChars(), tables, placeholder)
    const flags = (group: number, bit: number): boolean[] =>
      [0, 1, 2, 3].map(c => (tables.gfxProp[group * 4 + c] & bit) !== 0)

    // Group numbers are spelled out, NOT read back from MOLE_PROP_GROUPS -
    // otherwise mutating that table would not move this expectation.
    // DATA_01E361 (bank_01.asm:13410) = db $00,$05.
    expect(a.parts0.map(p => p.flipX)).toEqual(flags(0, 0x40))
    expect(a.parts0.map(p => p.flipY)).toEqual(flags(0, 0x80))
    expect(a.parts1.map(p => p.flipX)).toEqual(flags(5, 0x40))
    expect(a.parts1.map(p => p.flipY)).toEqual(flags(5, 0x80))
  })

  it('DATA PIN: the two quads are a horizontal mirror pair, not four unrelated tiles', () => {
    // Structural sanity from the method: a real pose shows repeats and a
    // swapped pair between frames. Frame 1 = frame 0 with the bottom row
    // swapped and every corner H-flipped, i.e. the mole looking the other way.
    const tables = romTables()
    const base   = tables.tilemapOffset[MOLE]
    const f0 = [0, 1, 2, 3].map(c => tables.tilemap[base + 4 + c])
    const f1 = [0, 1, 2, 3].map(c => tables.tilemap[base + 8 + c])

    expect(f0[0]).toBe(f0[1])                 // both head chars identical
    expect(f1).toEqual([f0[1], f0[0], f0[3], f0[2]])
  })

  it('buildSprites routes $4D to the two-frame pose, not buildSpriteLayout', () => {
    // End-to-end oracle: deleting the SpriteFactory $4D branch drops back to
    // the generic sub0 layout and this goes red.
    const rom    = SmwRom.open(ROM_PATH)
    const tables = readSpriteTileTables(rom.rom)!
    const base   = tables.tilemapOffset[MOLE]
    const high   = (tables.spriteAttr[MOLE] & 0x01) !== 0 ? 0x100 : 0

    const levelSprite: LevelSprite = {
      screen: 0, x: 5, y: 5, spriteId: MOLE, extraBit: false, raw: [0, 0, MOLE],
    }
    const built = buildSprites(rom.rom, [levelSprite], buildChars(), [], { x: 0, y: 0 }, new Map<number, Tile>())
    expect(built).toHaveLength(1)

    const app = built[0].appearance
    expect(app).toBeInstanceOf(MontyMoleAppearance)
    const mole = app as MontyMoleAppearance
    expect(mole.parts0.map(p => p.char.id)).toEqual(
      [0, 1, 2, 3].map(c => OBJ_BASE + high + tables.tilemap[base + 4 + c]),
    )
    expect(mole.parts1.map(p => p.flipX)).toEqual([true, true, true, true])
  })

  it('DATA PIN: the emerged annotation is SprTilemap[base + $02], the SubSprGfx2 byte', () => {
    // Expectation read FROM THE ROM at the offset the ASM derives:
    // SubSprGfx2Entry1 indexes SprTilemap by SpriteMisc1602 with no shift
    // (bank_01.asm:4154-4159), and state 2 sets it to $02
    // (CODE_01E37F, bank_01.asm:13426-13429).
    const tables = romTables()
    const base   = tables.tilemapOffset[MOLE]
    const high   = (tables.spriteAttr[MOLE] & 0x01) !== 0 ? 0x100 : 0
    const tile   = tables.tilemap[base + 0x02]

    const a = MontyMoleAppearance.fromTables(buildChars(), tables, placeholder)
    expect(a.emergedParts.map(p => p.char.id)).toEqual(
      [0x00, 0x01, 0x10, 0x11].map(c => OBJ_BASE + high + ((tile + c) & 0x1FF)),
    )
  })

  it('the emerged frame is none of the other SubSprGfx2 frames or mound chars', () => {
    // Oracle for a wrong emerged-frame source: the four SubSprGfx2 frame
    // bytes are distinct, and none of them appears in either mound quad.
    const tables = romTables()
    const base   = tables.tilemapOffset[MOLE]
    const frames = [0, 1, 2, 3].map(i => tables.tilemap[base + i])
    const mound  = [4, 5, 6, 7, 8, 9, 10, 11].map(i => tables.tilemap[base + i])

    expect(new Set(frames).size).toBe(4)
    expect(mound).not.toContain(frames[2])

    const a = MontyMoleAppearance.fromTables(buildChars(), tables, placeholder)
    const emergedBase = a.emergedParts[0].char.id
    for (const other of [0, 1, 3]) {
      const high = (tables.spriteAttr[MOLE] & 0x01) !== 0 ? 0x100 : 0
      expect(emergedBase).not.toBe(OBJ_BASE + high + (frames[other] & 0x1FF))
    }
  })

  /** Asymmetric pixel count of the emerged composite under one sprite set. */
  function emergedAsymmetry(rom: SmwRom, spriteSet: number): number {
    // SP1-SP4 come from SPRITEGFXLIST[spriteSet] and do not depend on the
    // BG tileset id, so tileset 0 is a safe constant here.
    const vram   = loadVram(rom.rom, 0, spriteSet)
    const tables = readSpriteTileTables(rom.rom)!
    const base   = tables.tilemapOffset[MOLE]
    const high   = (tables.spriteAttr[MOLE] & 0x01) !== 0 ? 0x100 : 0
    const tile   = tables.tilemap[base + 0x02]

    const quad = [0x00, 0x01, 0x10, 0x11]
      .map(c => getCharPixels(vram, OBJ_BASE + high + ((tile + c) & 0x1FF)))
    expect(quad.every(q => q !== null)).toBe(true)

    const px = (X: number, Y: number): number => {
      const idx = (Y < 8 ? 0 : 2) + (X < 8 ? 0 : 1)
      return quad[idx]![(Y % 8) * 8 + (X % 8)]
    }
    let asym = 0
    for (let Y = 0; Y < 16; Y++) {
      for (let X = 0; X < 8; X++) if (px(X, Y) !== px(15 - X, Y)) asym++
    }
    return asym
  }

  it('the emerged composite is mirror-symmetric in sprite set 5 ONLY', () => {
    // SubSprGfx2Entry1 derives X-flip from SpriteMisc157C
    // (bank_01.asm:4166-4171), which FaceMario (bank_01.asm:13373) sets at
    // runtime, and the repo hardcodes flipX=false on that path.
    //
    // The previous version of this test loaded level $010 alone and
    // concluded the pose is symmetric, full stop. Sweeping the range shows
    // that holds for exactly one of the sixteen sprite sets. Pinned as a
    // literal table, not recomputed, so a GFX or slot-mapping change moves
    // it. Evidence scope: Super Mario World (USA).vanilla.sfc, headerless.
    const rom = SmwRom.open(ROM_PATH)
    const asym = Array.from({ length: 16 }, (_, s) => emergedAsymmetry(rom, s))
    expect(asym).toEqual([32, 73, 18, 13, 82, 0, 13, 31, 9, 91, 28, 19, 56, 18, 56, 19])
    expect(asym.filter(n => n === 0)).toHaveLength(1)
    expect(asym[5]).toBe(0)
  })

  it('every vanilla $4D/$4E placement is in the one symmetric sprite set', () => {
    // Why vanilla renders faithfully anyway. Not a general property:
    // Grand Poo World 2 puts 16 of its 17 $4D in other sets. Hardcoding
    // flipX=false there is still not a pixel defect - the same four chars
    // are drawn, only mirrored, and the ROM has no static facing to be
    // faithful to. See docs/sprite-4d-monty-mole.md.
    const rom = SmwRom.open(ROM_PATH)
    const sets = new Set<number>()
    let placements = 0
    for (let lv = 0; lv < 0x200; lv++) {
      const raw = rom.getLevelRawData(lv)
      const ptr = rom.getLevelSpritePointer(lv)
      if (!raw || !ptr) continue
      const sdata = rom.rom.readAt(ptr, 1024)
      if (!sdata) continue
      const moles = parseLevelSprites(sdata)
        .filter(s => s.spriteId === 0x4D || s.spriteId === 0x4E)
      if (moles.length === 0) continue
      placements += moles.length
      sets.add(parseLevelHeader(raw).spriteSet)
    }
    expect(placements).toBeGreaterThan(0)
    expect([...sets]).toEqual([5])
  })

  it('the SpriteMisc1602 = 0 quad the generic builder read is a different set', () => {
    // Regression pin for the reported symptom: base + 0..3 is the sprite's
    // SubSprGfx2 single-tile frame list (CODE_01E3EF / the $4E branch), so
    // rendering it as four 8x8 corners shows four unrelated chars.
    const tables = romTables()
    const base   = tables.tilemapOffset[MOLE]
    const stale  = [0, 1, 2, 3].map(c => tables.tilemap[base + c])
    const f0     = [0, 1, 2, 3].map(c => tables.tilemap[base + 4 + c])

    expect(stale).not.toEqual(f0)
    expect(new Set(stale).size).toBe(4)       // four distinct chars - the scramble
  })
})
