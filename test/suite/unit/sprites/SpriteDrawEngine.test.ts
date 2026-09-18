/**
 * Unit tests for the table-driven sprite draw engine.
 *
 * Test tree:
 *   frameIndexAt / animPeriodFrames   - cadence is expressed in GAME frames
 *   resolveMisc157C                   - SubHorizPos polarity
 *   sub0 / sub1 / sub2                - the three routine ports, synthetic tables
 *   palette                           - static, init-table-by-X, dynamic CGRAM
 *   descriptor round-trip             - the serialization boundary
 *
 * All tests here are SYNTHETIC: no ROM byte is loaded. The tables are built by
 * hand so an expectation can never be read out of the table under test, which
 * is the tautology that has already bitten two sibling branches.
 */

import { describe, it, expect } from 'vitest'
import type { RomFile } from '../../../../src/rom/RomFile'
import type { SpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import {
  ROM_FRAMES_PER_TICK, animPeriodFrames, drawSpriteParts, frameIndexAt,
  resolveMisc157C,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'
import type { SpriteDrawDescriptor } from '../../../../src/rom/model/sprites/generic/SpriteDrawDescriptor'

// ── Synthetic fixtures ──────────────────────────────────────────────────────

/** A fake cart exposing only `readAt`, which is all the engine uses. */
function fakeRom(bytes: Record<number, number[]>): RomFile {
  return {
    readAt(addr: number, len: number) {
      for (const [baseStr, data] of Object.entries(bytes)) {
        const base = Number(baseStr)
        if (addr >= base && addr + len <= base + data.length) {
          return Buffer.from(data.slice(addr - base, addr - base + len))
        }
      }
      return null
    },
  } as unknown as RomFile
}

/**
 * Synthetic tile tables with deliberately DISTINCT values everywhere, so a
 * wrong index produces a wrong number rather than an accidental match.
 * tilemap[i] = 0x10 + i, gfxProp is a hand-written flip matrix.
 */
function tables(over: Partial<SpriteTileTables> = {}): SpriteTileTables {
  return {
    tilemap: Uint8Array.from({ length: 0x40 }, (_, i) => 0x10 + i),
    tilemapOffset: Uint8Array.from({ length: 0x54 }, () => 0x00),
    dispX: [0, 8, 0, 8],
    dispY: [0, 0, 8, 8],
    // group 0 = no flips; group 1 = X-flip on corners 1,3; group 2 = Y-flip all
    gfxProp: [
      0x00, 0x00, 0x00, 0x00,
      0x00, 0x40, 0x00, 0x40,
      0x80, 0x80, 0x80, 0x80,
    ],
    spriteAttr: Uint8Array.from({ length: 0x100 }, () => 0x00),
    spr0to13Prop: new Uint8Array(0x14),
    ...over,
  }
}

/** Latch 1 = "Mario is left", which is the UNFLIPPED pose. The fixture uses
 *  it as the baseline so that every expectation below states its flip
 *  intent explicitly, rather than inheriting one by accident. */
const BASE_DESC: SpriteDrawDescriptor = {
  spriteId: 0x10,
  routine: 'sub2',
  vanillaMainHandler: 0x1234,
  vanillaInitHandler: 0x5678,
  frames: 1,
  anim: { kind: 'static' },
  tileGroup: { kind: 'const', value: 0 },
  misc157C: { kind: 'const', value: 1 },
  palette: { kind: 'spriteTable' },
  representativeFrame: 0,
  needsHumanReview: true,
  evidence: 'synthetic fixture',
}

const CTX = { marioX: 0, romFrame: 0 }

function draw(d: Partial<SpriteDrawDescriptor>, opts: { spriteX?: number; romFrame?: number; marioX?: number; t?: SpriteTileTables; rom?: RomFile } = {}) {
  const res = drawSpriteParts({
    rom: opts.rom ?? fakeRom({}),
    tables: opts.t ?? tables(),
    descriptor: { ...BASE_DESC, ...d },
    spriteX: opts.spriteX ?? 0,
    ctx: { marioX: opts.marioX ?? CTX.marioX, romFrame: opts.romFrame ?? 0 },
  })
  if (!res.ok) throw new Error(`draw failed: ${JSON.stringify(res.failure)}`)
  return res
}

// ── Cadence ─────────────────────────────────────────────────────────────────

describe('animation cadence is expressed in GAME frames', () => {
  it('one editor tick is 7.5 game frames, not one', () => {
    // SPRITE_ANIM_INTERVAL_MS = 125 in webview/mapEditor/main.ts, 60 fps.
    // SpikeTopAppearance counts ANIM_TICKS = 8 in TICKS, which is this factor
    // too slow. The conversion must live in exactly one place.
    // EXACTLY 7.5, not close to it. `toBeCloseTo(7.5, 10)` passed for the
    // `125 / (1000 / 60)` form, which is 7.499999999999999, and that form's
    // accumulated floor differs from this one's on 100 of the first 200 ticks.
    // A tolerance here is a tolerance for the drift.
    expect(ROM_FRAMES_PER_TICK).toBe(7.5)
  })

  it('effFrame frame index is (romFrame >> shift) & mask', () => {
    // $4D Monty Mole: (EffFrame >> 4) & 1 - bank_01.asm:13392.
    const anim = { kind: 'effFrame', shift: 4, mask: 1 } as const
    expect(frameIndexAt(anim, 0)).toBe(0)
    expect(frameIndexAt(anim, 15)).toBe(0)
    expect(frameIndexAt(anim, 16)).toBe(1)
    expect(frameIndexAt(anim, 31)).toBe(1)
    expect(frameIndexAt(anim, 32)).toBe(0)
  })

  it('period is (mask + 1) << shift game frames', () => {
    expect(animPeriodFrames({ kind: 'effFrame', shift: 4, mask: 1 })).toBe(32)
    // SetAnimationFrame: (counter >> 3) & 1 - a 16-game-frame walk cycle.
    expect(animPeriodFrames({ kind: 'spriteCounter', shift: 3, mask: 1 })).toBe(16)
    expect(animPeriodFrames({ kind: 'static' })).toBe(0)
  })

  it('a 2-frame 32-frame-period animation advances in about 2 editor ticks', () => {
    // Guards the tick/frame confusion directly: at 7.5 frames per tick, a
    // shift-4 animation must change frame between tick 2 and tick 3, not
    // after 8 ticks.
    const anim = { kind: 'effFrame', shift: 4, mask: 1 } as const
    expect(frameIndexAt(anim, 2 * ROM_FRAMES_PER_TICK)).toBe(0)   // 15.0
    expect(frameIndexAt(anim, 3 * ROM_FRAMES_PER_TICK)).toBe(1)   // 22.5
  })
})

// ── Direction latch ─────────────────────────────────────────────────────────

describe('SpriteMisc157C from SubHorizPos', () => {
  it('faceMario gives latch 0 when Mario is at or right of the sprite', () => {
    // bank_01.asm:6124 SubHorizPos - Y stays 0 when (Mario - Sprite) >= 0.
    expect(resolveMisc157C({ kind: 'faceMario' }, 100, 200)).toBe(0)
    expect(resolveMisc157C({ kind: 'faceMario' }, 100, 100)).toBe(0)
  })

  it('faceMario gives latch 1 when Mario is left of the sprite', () => {
    expect(resolveMisc157C({ kind: 'faceMario' }, 100, 50)).toBe(1)
  })

  it('an unwritten latch is 0, which the routines read as "apply X-flip"', () => {
    expect(resolveMisc157C({ kind: 'unwritten' }, 100, 50)).toBe(0)
  })
})

// ── Routine ports ───────────────────────────────────────────────────────────

describe('SubSprGfx0Entry0 - four independent 8x8 chars', () => {
  it('reads one tile per corner at tilemapBase + misc1602*4 + corner', () => {
    // tilemap[i] = 0x10 + i, offset 0, misc1602 = 0 -> tiles 0x10..0x13.
    const parts = draw({ routine: 'sub0', propGroup: { kind: 'const', value: 0 } }).parts
    expect(parts.map(p => p.charNum - 0x400)).toEqual([0x10, 0x11, 0x12, 0x13])
  })

  it('misc1602 strides by FOUR, not one', () => {
    // This is the pinned-to-zero defect: with misc1602 = 2 the quad must be
    // tiles 8..11 past the base, not 2 past it.
    const parts = draw({
      routine: 'sub0', tileGroup: { kind: 'const', value: 2 },
      propGroup: { kind: 'const', value: 0 },
    }).parts
    expect(parts.map(p => p.charNum - 0x400)).toEqual([0x18, 0x19, 0x1A, 0x1B])
  })

  it('takes per-corner flips from GeneralSprGfxProp[group*4 + corner]', () => {
    // Group 1 of the fixture is 00 40 00 40 -> X-flip on corners 1 and 3.
    const parts = draw({
      routine: 'sub0', tileGroup: { kind: 'const', value: 0 },
      propGroup: { kind: 'const', value: 1 },
    }).parts
    expect(parts.map(p => p.flipX)).toEqual([false, true, false, true])
    expect(parts.map(p => p.flipY)).toEqual([false, false, false, false])
  })

  it('reads bit 7 of the prop byte as Y-flip', () => {
    const parts = draw({
      routine: 'sub0', tileGroup: { kind: 'const', value: 0 },
      propGroup: { kind: 'const', value: 2 },
    }).parts
    expect(parts.map(p => p.flipY)).toEqual([true, true, true, true])
  })

  it('places corners at GeneralSprDispX/Y = (0,0) (8,0) (0,8) (8,8)', () => {
    const parts = draw({ routine: 'sub0', propGroup: { kind: 'const', value: 0 } }).parts
    expect(parts.map(p => [p.dx, p.dy])).toEqual([[0, 0], [8, 0], [0, 8], [8, 8]])
  })

  it('resolves the tile group and prop group from ROM TABLES, not literals', () => {
    // The $4D Monty Mole shape: tile-group table and prop-group table, both
    // indexed by frame. Values here are invented, NOT the cart's, so a test
    // that accidentally read the real table would fail.
    const rom = fakeRom({ 0x020000: [2, 1], 0x020010: [2, 1] })
    const d = {
      routine: 'sub0' as const,
      anim: { kind: 'effFrame', shift: 4, mask: 1 } as const,
      tileGroup: { kind: 'table', addr: 0x020000 } as const,
      propGroup: { kind: 'table', addr: 0x020010 } as const,
    }
    // frame 0 -> tileGroup 2 -> tiles 0x18.., propGroup 2 -> all Y-flipped
    const f0 = draw(d, { rom, romFrame: 0 }).parts
    expect(f0.map(p => p.charNum - 0x400)).toEqual([0x18, 0x19, 0x1A, 0x1B])
    expect(f0.every(p => p.flipY)).toBe(true)
    // frame 1 -> tileGroup 1 -> tiles 0x14.., propGroup 1 -> X-flip on 1 and 3
    const f1 = draw(d, { rom, romFrame: 16 }).parts
    expect(f1.map(p => p.charNum - 0x400)).toEqual([0x14, 0x15, 0x16, 0x17])
    expect(f1.map(p => p.flipX)).toEqual([false, true, false, true])
  })
})

describe('SubSprGfx1 - two stacked 16x16 large OBJs', () => {
  it('emits EIGHT subtiles, anchored on the TOP entry with the bottom +$10', () => {
    // `SubSprGfx1` stores `_1` to `OAMTileYPos+$100` and `_1 + $10` to
    // `+$104` (bank_01.asm:3948-3952), so the routine's own origin is the
    // TOP entry and the bottom sits 16 px below it. Anchoring on the bottom
    // instead required a `ROUTINE_BASE_DY` constant to undo, which the
    // handler Y adjust then had to undo again, and $1F, which has no handler
    // Y adjust at all (bank_01.asm:8529 has no `SBC` before its `JSR`),
    // ended up 16 px too high.
    const parts = draw({ routine: 'sub1' }).parts
    expect(parts).toHaveLength(8)
    expect(parts.slice(0, 4).map(p => p.dy)).toEqual([0, 0, 8, 8])
    expect(parts.slice(4).map(p => p.dy)).toEqual([16, 16, 24, 24])
  })

  it('indexes the tilemap by misc1602 * 2 and takes two consecutive tiles', () => {
    const parts = draw({ routine: 'sub1', tileGroup: { kind: 'const', value: 3 } }).parts
    // idx = 0 + 3*2 = 6 -> top = tilemap[6] = 0x16, bottom = tilemap[7] = 0x17
    expect(parts[0].charNum - 0x400).toBe(0x16)
    expect(parts[4].charNum - 0x400).toBe(0x17)
  })

  it('uses ONE attribute for both entries - it never reads GeneralSprGfxProp', () => {
    // Prop group 1 would X-flip corners 1 and 3 on the sub0 path. On sub1 the
    // whole sprite must share one flip, so all eight agree.
    const parts = draw({ routine: 'sub1', propGroup: { kind: 'const', value: 1 } }).parts
    expect(new Set(parts.map(p => p.flipX)).size).toBe(1)
  })

  it('X-flips when the latch is CLEAR, not when it is set', () => {
    // bank_01.asm CODE_019DA9: BCS skips the ORA #!OBJ_XFlip.
    expect(draw({ routine: 'sub1', misc157C: { kind: 'const', value: 0 } }).parts[0].flipX).toBe(true)
    expect(draw({ routine: 'sub1', misc157C: { kind: 'const', value: 1 } }).parts[0].flipX).toBe(false)
  })

  it('a handler that never writes the latch renders FLIPPED', () => {
    // The precise reason hardcoding flipX: false is wrong rather than partial.
    expect(draw({ routine: 'sub1', misc157C: { kind: 'unwritten' } }).parts[0].flipX).toBe(true)
  })
})

describe('SubSprGfx2Entry1 - one 16x16 large OBJ', () => {
  it('expands base char N to N, N+1, N+$10, N+$11', () => {
    const parts = draw({ routine: 'sub2', tileGroup: { kind: 'const', value: 0 } }).parts
    expect(parts).toHaveLength(4)
    expect(parts.map(p => p.charNum - 0x400)).toEqual([0x10, 0x11, 0x20, 0x21])
  })

  it('misc1602 strides by ONE on this path', () => {
    const parts = draw({ routine: 'sub2', tileGroup: { kind: 'const', value: 3 } }).parts
    expect(parts[0].charNum - 0x400).toBe(0x13)
  })

  it('X-flip swaps the corner chars as well as mirroring each 8x8', () => {
    const flipped = draw({ routine: 'sub2', misc157C: { kind: 'const', value: 0 } }).parts
    expect(flipped.every(p => p.flipX)).toBe(true)
    expect(flipped.map(p => p.charNum - 0x400)).toEqual([0x11, 0x10, 0x21, 0x20])
  })

  it('EORs rather than ORs the flip, so a handler flip bit cancels the latch flip', () => {
    // bank_01.asm:4171 uses EOR #!OBJ_XFlip where SubSprGfx1 uses ORA.
    // attrOverride sets bit 6; latch 1 means "no latch flip", so the
    // handler's own flip survives.
    const withAttr = draw({
      routine: 'sub2',
      attrOverride: { kind: 'const', value: 0x40 },
      misc157C: { kind: 'const', value: 1 },
    }).parts
    expect(withAttr.every(p => p.flipX)).toBe(true)
  })

  it('rotates flip bits from EffFrame when the handler overrides the attribute', () => {
    // $4E: ((EffFrame << 2) & $C0) | $31 - bank_01.asm:13412. Four poses out
    // of ONE tile. Frame 0 -> no flips from the mask; frame 3 -> both.
    const d = {
      routine: 'sub2' as const,
      attrOverride: { kind: 'effFrameFlip', shl: 2, andMask: 0xC0, orMask: 0x31 } as const,
      misc157C: { kind: 'const', value: 1 } as const,
    }
    expect(draw(d, { romFrame: 0 }).parts[0].flipY).toBe(false)
    expect(draw(d, { romFrame: 32 }).parts[0].flipY).toBe(true)   // (32<<2)&$C0 = $80
    expect(draw(d, { romFrame: 16 }).parts[0].flipX).toBe(true)    // (16<<2)&$C0 = $40
    // and it WRAPS in 8 bits: frame 64 shifts to $100 -> 0, back to pose 0
    expect(draw(d, { romFrame: 64 }).parts[0].flipY).toBe(false)
  })
})

// ── Palette ─────────────────────────────────────────────────────────────────

describe('the sprite defines its palette; the level palette is only a fallback', () => {
  it('(a) static: row = 8 + ((attr >> 1) & 7), charHigh = attr & 1', () => {
    const t = tables()
    t.spriteAttr[0x10] = 0x0B          // 1011: palette index 5, charHigh 1
    const parts = draw({}, { t }).parts
    expect(parts[0].palette).toBe(8 + 5)
    expect(parts[0].charNum).toBe(0x400 + 0x100 + 0x10)   // charHigh adds a page first
  })

  it('(b) an INIT-routine override indexed by the sprite X column', () => {
    // $2C Yoshi Egg: YoshiPal[(SpriteXPosLow >> 4) & 3]. The table ADDRESS is
    // read from the operand of the instruction that consumes it, so a hack
    // that relocates the table still resolves.
    const rom = fakeRom({
      0x018343: [0x35, 0x83],              // operand -> $01:8335
      0x018335: [0x01, 0x03, 0x05, 0x07],  // invented, not the cart's values
    })
    const pal = { kind: 'initTableByX', operandAddr: 0x018343, operandBank: 0x01, entries: 4, shift: 4, mask: 3 } as const
    // X = 0x20 -> (0x20 >> 4) & 3 = 2 -> attr 0x05 -> row 8 + 2 = 10
    expect(draw({ palette: pal }, { rom, spriteX: 0x20 }).parts[0].palette).toBe(10)
    // X = 0x10 -> index 1 -> attr 0x03 -> row 8 + 1 = 9
    expect(draw({ palette: pal }, { rom, spriteX: 0x10 }).parts[0].palette).toBe(9)
  })

  it('(c) a runtime CGRAM DMA is detected and flagged for PARTIAL-row compositing', () => {
    // $1F Magikoopa writes 8 colours to CGRAM index $F0 = row 15 columns 0-7,
    // so columns 8-15 still come from the level palette. A whole-row model
    // would be wrong here.
    const rom = fakeRom({ 0x01C037: [0x02, 0xB9, 0x03] })   // -> $03B902
    const res = draw({
      routine: 'sub1',
      palette: { kind: 'dynamicCgram', operandAddr: 0x01C037, colorsPerEntry: 8, entryCount: 8, cgramStart: 0xF0, restingEntry: 7 },
    }, { rom })
    expect(res.paletteNote).toEqual({
      kind: 'dynamicCgram', row: 15, firstCol: 0, colors: 8,
      entryAddr: 0x03B902 + 7 * 8 * 2,
    })
    expect(res.parts.every(p => p.palette === 15)).toBe(true)
  })

  it('a partial-row note leaves the untouched columns to the caller', () => {
    const rom = fakeRom({ 0x01C037: [0x02, 0xB9, 0x03] })
    const res = draw({
      palette: { kind: 'dynamicCgram', operandAddr: 0x01C037, colorsPerEntry: 8, entryCount: 8, cgramStart: 0xF0, restingEntry: 7 },
    }, { rom })
    const note = res.paletteNote!
    expect(note.firstCol + note.colors).toBeLessThan(16)
  })
})

// ── Facing is a render-time input ───────────────────────────────────────────

describe('facing is derived at render time, not baked in at construction', () => {
  it('the same descriptor renders mirrored at two different Mario positions', () => {
    // The dynamic path is the one that silently degrades to frozen behaviour,
    // so it needs its own case rather than being implied by the polarity test.
    const d = { routine: 'sub2' as const, misc157C: { kind: 'faceMario' } as const }
    const marioRight = draw(d, { spriteX: 100, marioX: 500 }).parts
    const marioLeft = draw(d, { spriteX: 100, marioX: 0 }).parts
    expect(marioRight[0].flipX).toBe(true)
    expect(marioLeft[0].flipX).toBe(false)
    expect(marioRight.map(p => p.charNum)).not.toEqual(marioLeft.map(p => p.charNum))
  })

  it('costs no extra ROM read and no rebuild - the descriptor object is reused as-is', () => {
    const d: SpriteDrawDescriptor = { ...BASE_DESC, misc157C: { kind: 'faceMario' } }
    const t = tables()
    let reads = 0
    const counting = { readAt: () => { reads++; return null } } as unknown as RomFile
    const positions = [0, 500, 0, 500]
    for (const marioX of positions) {
      drawSpriteParts({ rom: counting, tables: t, descriptor: d, spriteX: 100, ctx: { marioX, romFrame: 0 } })
    }
    // Exactly one: the MAIN pointer, which is what handler-relative offsets
    // are anchored to. Facing itself reads nothing, which is the claim.
    expect(reads).toBe(positions.length)
  })
})

// ── Serialization boundary ──────────────────────────────────────────────────

describe('descriptors survive the host -> webview boundary', () => {
  it('a JSON round-trip produces byte-identical parts', () => {
    // Phase 1 adds no new state to MapPayload, so there is no serialize /
    // rehydrate branch to test yet. What the eventual branch depends on is
    // that a descriptor is plain JSON-able data with no resolved booleans in
    // it, so the webview can recompute facing locally when Mario moves. That
    // property is what this locks.
    const d: SpriteDrawDescriptor = {
      ...BASE_DESC,
      routine: 'sub1',
      misc157C: { kind: 'faceMario' },
      anim: { kind: 'effFrame', shift: 4, mask: 1 },
      tileGroup: { kind: 'table', addr: 0x020000 },
    }
    const revived = JSON.parse(JSON.stringify(d)) as SpriteDrawDescriptor
    expect(revived).toEqual(d)

    const rom = fakeRom({ 0x020000: [1, 2] })
    const t = tables()
    for (const marioX of [0, 500]) {
      const a = drawSpriteParts({ rom, tables: t, descriptor: d, spriteX: 100, ctx: { marioX, romFrame: 0 } })
      const b = drawSpriteParts({ rom, tables: t, descriptor: revived, spriteX: 100, ctx: { marioX, romFrame: 0 } })
      expect(a).toEqual(b)
    }
  })

  it('carries no resolved flip - only the rule and its inputs', () => {
    const d = JSON.stringify(BASE_DESC)
    expect(d).not.toContain('flipX')
    expect(d).not.toContain('faceRight')
  })
})

// ── sub0 addresses its OAM entries in reverse corner order ─────────────────

/**
 * `SubSprGfx0Entry0` seeds its corner index `_4` with $03 and counts DOWN
 * (bank_01.asm:3874, 3904-3905) while the OAM index Y counts UP four at a
 * time (bank_01.asm:3900-3903). OAM slot 0 therefore holds CORNER 3.
 *
 * `drawSub0` emits corners in 0..3 order, which is the order their positions
 * read in, so anything addressing an entry by OAM slot has to reverse. No
 * shipped `sub0` descriptor uses a `TileNudge` or a `TileOverride` yet, so
 * this was latent and the first one would have been silently off by three.
 * Exercised here on a synthetic descriptor rather than left as a comment.
 */
describe('sub0 OAM slots map to reversed corners', () => {
  /**
   * `INC OAMTileYPos+$100+slot,X` behind a gate that always passes.
   *
   * ONE contiguous block, because `fakeRom` serves a read only when the
   * whole span falls inside a single entry and `bitSelect` scans `max`
   * bytes. The window is `SBC #$00` then `CMP #$00`, so `diff` is 0 and
   * `0 < 0` is false: the nudge fires. An `LSR` run of zero leaves the
   * bit test out of it.
   */
  const NUDGE_BASE = 0x020000
  const nudgeRom = (slot: number) => fakeRom({
    [NUDGE_BASE]: [
      0x00,                                    // +0  windowBase  SBC #$00
      0x00,                                    // +1  windowSize  CMP #$00
      0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA, 0xEA,  // +2  no LSR run
      0xFE, (0x0301 + slot) & 0xFF, (0x0301 + slot) >> 8,  // +$A INC abs,X
    ],
  })
  const nudge = (slot: number) => ({
    windowBase: NUDGE_BASE, windowSize: NUDGE_BASE + 1,
    bitSelect: { scan: NUDGE_BASE + 2, max: 8 }, insnAddr: NUDGE_BASE + 0x0A,
    evidence: 'synthetic',
  })

  it('a nudge on OAM slot 0 moves the LAST corner, not the first', () => {
    const base = draw({ routine: 'sub0', propGroup: { kind: 'const', value: 0 } }).parts
    const moved = draw(
      { routine: 'sub0', propGroup: { kind: 'const', value: 0 }, tileNudges: [nudge(0)] },
      { rom: nudgeRom(0) },
    ).parts
    const deltas = moved.map((p, i) => p.dy - base[i].dy)
    expect(deltas).toEqual([0, 0, 0, 1])
  })

  it('a nudge on OAM slot $0C moves the FIRST corner', () => {
    const base = draw({ routine: 'sub0', propGroup: { kind: 'const', value: 0 } }).parts
    const moved = draw(
      { routine: 'sub0', propGroup: { kind: 'const', value: 0 }, tileNudges: [nudge(0x0C)] },
      { rom: nudgeRom(0x0C) },
    ).parts
    expect(moved.map((p, i) => p.dy - base[i].dy)).toEqual([1, 0, 0, 0])
  })

  it('a slot past the four entries is reported, not silently dropped', () => {
    const res = drawSpriteParts({
      rom: nudgeRom(0x10), tables: tables(),
      descriptor: { ...BASE_DESC, routine: 'sub0', propGroup: { kind: 'const', value: 0 }, tileNudges: [nudge(0x10)] },
      spriteX: 0, ctx: CTX,
    })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.failure.kind).toBe('nudgeTargetOutOfRange')
  })

  it('a MISALIGNED slot is reported: OAM entries are four bytes apart', () => {
    // Slot $02 is inside the routine's first entry but is not its Y byte.
    // The alignment check is separate from the range check, and slot $10
    // above exercises only the range one.
    const res = drawSpriteParts({
      rom: nudgeRom(0x02), tables: tables(),
      descriptor: { ...BASE_DESC, routine: 'sub0', propGroup: { kind: 'const', value: 0 }, tileNudges: [nudge(0x02)] },
      spriteX: 0, ctx: CTX,
    })
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.failure.kind).toBe('nudgeTargetOutOfRange')
  })

  it('a sub0 tile OVERRIDE on slot 0 replaces the LAST corner', () => {
    // The same reversal, on the other kind that addresses an entry by slot.
    const ovRom = fakeRom({ 0x030000: [0xA9, 0x77] })   // LDA #$77
    const over = [{ insnAddr: 0x030000, oamSlot: 0x00, evidence: 'synthetic' }]
    const base = draw({ routine: 'sub0', propGroup: { kind: 'const', value: 0 } }).parts
    const out = draw(
      { routine: 'sub0', propGroup: { kind: 'const', value: 0 }, tileOverrides: over },
      { rom: ovRom },
    ).parts
    const changed = out.map((p, i) => p.charNum !== base[i].charNum)
    expect(changed).toEqual([false, false, false, true])
    expect(out[3].charNum).toBe(0x400 + 0x77)
  })

  it('a sub0 tile override on slot $0C replaces the FIRST corner', () => {
    const ovRom = fakeRom({ 0x030000: [0xA9, 0x77] })
    const over = [{ insnAddr: 0x030000, oamSlot: 0x0C, evidence: 'synthetic' }]
    const out = draw(
      { routine: 'sub0', propGroup: { kind: 'const', value: 0 }, tileOverrides: over },
      { rom: ovRom },
    ).parts
    expect(out[0].charNum).toBe(0x400 + 0x77)
  })

  it('sub1 and sub2 are NOT reversed: slot 0 is their first entry', () => {
    const base1 = draw({ routine: 'sub1' }).parts
    const moved1 = draw({ routine: 'sub1', tileNudges: [nudge(0)] }, { rom: nudgeRom(0) }).parts
    // The four corners of the TOP large OBJ, which is the routine's first entry.
    expect(moved1.map((p, i) => p.dy - base1[i].dy)).toEqual([1, 1, 1, 1, 0, 0, 0, 0])

    const base2 = draw({ routine: 'sub2' }).parts
    const moved2 = draw({ routine: 'sub2', tileNudges: [nudge(0)] }, { rom: nudgeRom(0) }).parts
    expect(moved2.map((p, i) => p.dy - base2[i].dy)).toEqual([1, 1, 1, 1])
  })
})
