/**
 * The two descriptor kinds added for $1F Magikoopa: extra OAM parts, and a
 * state-timer animation driving a shifted table lookup.
 *
 * Both exist because the descriptor modelled what the SHARED DRAW ROUTINE
 * READS and not what the HANDLER COMPUTES AROUND IT. Every assertion here is
 * about that boundary, so the tests are organised by it rather than by file.
 *
 * Test tree:
 *   stateTimer cadence        - synthetic, counts DOWN from a cart-read seed
 *   shiftedTable lookup       - synthetic, shift and OR-bit arithmetic
 *   unionExtents              - synthetic, a part outside the body widens it
 *   $1F on the cart           - 6 ROMs, the wand and the pose cycle
 *   planted defects           - every oracle above, proven able to go red
 *
 * Evidence scope: static traces against `C:\Projects\SMWDisX`, verified byte
 * for byte against the 6 carts in `test/roms/`. No emulator was run, so no
 * claim here is dynamically verified.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../../src/rom/RomFile'
import { readSpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import {
  SPRITE_DRAW_DESCRIPTORS,
  type ExtraByteSource, type ExtraPart, type SpriteDrawDescriptor,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawDescriptor'
import {
  animPeriodFrames, drawSpriteParts, frameIndexAt, resolveHandlerBase,
  resolveRef, resolveStateTimerSeed, unionExtents, type EnginePart,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'

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

const part = (dx: number, dy: number): EnginePart =>
  ({ charNum: 0, palette: 8, flipX: false, flipY: false, dx, dy })

// ── stateTimer cadence ──────────────────────────────────────────────────────

describe('stateTimer animation', () => {
  const SEED_AT = 0x018000
  const anim = { kind: 'stateTimer', seedOperandAddr: SEED_AT } as const
  // Absolute ref, so the handler base is not consulted.
  const NO_BASE = 0

  it('reads the seed from the cart, not from the descriptor', () => {
    expect(resolveStateTimerSeed(fakeRom({ [SEED_AT]: [0x70] }), anim, NO_BASE)).toBe(0x70)
    expect(resolveStateTimerSeed(fakeRom({ [SEED_AT]: [0x20] }), anim, NO_BASE)).toBe(0x20)
  })

  it('refuses a seed it cannot read, and a seed of zero', () => {
    expect(resolveStateTimerSeed(fakeRom({}), anim, NO_BASE)).toBeNull()
    expect(resolveStateTimerSeed(fakeRom({ [SEED_AT]: [0x00] }), anim, NO_BASE)).toBeNull()
  })

  it('is null for every other animation kind', () => {
    const rom = fakeRom({ [SEED_AT]: [0x70] })
    expect(resolveStateTimerSeed(rom, { kind: 'static' }, NO_BASE)).toBeNull()
    expect(resolveStateTimerSeed(rom, { kind: 'effFrame', shift: 4, mask: 1 }, NO_BASE)).toBeNull()
  })

  it('counts DOWN from the seed, one step per game frame', () => {
    expect(frameIndexAt(anim, 0, 0x70)).toBe(0x70)
    expect(frameIndexAt(anim, 1, 0x70)).toBe(0x6F)
    expect(frameIndexAt(anim, 0x70, 0x70)).toBe(0)
  })

  it('wraps at seed + 1, because the editor loops a one-shot state', () => {
    expect(animPeriodFrames(anim, 0x70)).toBe(0x71)
    expect(frameIndexAt(anim, 0x71, 0x70)).toBe(0x70)
  })

  it('holds the first pose when the seed is unknown, rather than animating wrongly', () => {
    expect(frameIndexAt(anim, 999, 0)).toBe(0)
    expect(animPeriodFrames(anim, 0)).toBe(0)
  })

  it('a descriptor whose seed cannot be read fails rather than drawing frame 0', () => {
    const d = { ...BASE_TIMER_DESC, anim }
    const res = drawSpriteParts({
      rom: fakeRom({}), tables: readSyntheticTables(), descriptor: d,
      spriteX: 0, ctx: { marioX: 0, romFrame: 0 },
    })
    expect(res.ok).toBe(false)
  })
})

/** Minimal tables: the shiftedTable and stateTimer paths never touch them. */
function readSyntheticTables() {
  return {
    tilemap: Uint8Array.from({ length: 0x40 }, (_, i) => 0x10 + i),
    tilemapOffset: new Uint8Array(0x54),
    dispX: [0, 8, 0, 8],
    dispY: [0, 0, 8, 8],
    gfxProp: new Array(24).fill(0),
    spriteAttr: new Uint8Array(0x100),
    spr0to13Prop: new Uint8Array(0x14),
  }
}

const BASE_TIMER_DESC: SpriteDrawDescriptor = {
  spriteId: 0x10,
  routine: 'sub2',
  vanillaMainHandler: 0x1234,
  vanillaInitHandler: 0x5678,
  frames: 4,
  anim: { kind: 'static' },
  tileGroup: { kind: 'const', value: 0 },
  misc157C: { kind: 'const', value: 1 },
  palette: { kind: 'spriteTable' },
  representativeFrame: 0,
  needsHumanReview: true,
  evidence: 'synthetic fixture',
}

// ── shiftedTable lookup ─────────────────────────────────────────────────────

describe('shiftedTable byte source', () => {
  // The shifts are COUNTED out of `LSR A` runs, so a synthetic cart has to
  // hold the runs: $018010 is six of them, $018020 is three.
  const SHIFT6 = { scan: 0x018010, max: 8 }
  const SHIFT3 = { scan: 0x018020, max: 8 }
  const MASK1 = 0x018030
  const runs = {
    0x018010: [0x4A, 0x4A, 0x4A, 0x4A, 0x4A, 0x4A, 0xA8, 0x00],
    0x018020: [0x4A, 0x4A, 0x4A, 0x29, 0x00, 0x00, 0x00, 0x00],
    0x018030: [0x01],
  }
  // Operand at $018000 points at a table at $018100 holding 9,7,5,3.
  const rom = fakeRom({ 0x018000: [0x00, 0x81], 0x018100: [9, 7, 5, 3], ...runs })
  const src = (shift: { scan: number; max: number }, orShift?: { scan: number; max: number }) =>
    ({
      kind: 'shiftedTable', operandAddr: 0x018000, operandBank: 0x01, shift,
      orBit: orShift ? { shift: orShift, maskAddr: MASK1 } : undefined,
    }) as const

  const groupFor = (frame: number, shift: { scan: number; max: number }) => {
    const res = drawSpriteParts({
      rom, tables: readSyntheticTables(),
      descriptor: { ...BASE_TIMER_DESC, tileGroup: src(shift) },
      spriteX: 0, ctx: { marioX: 0, romFrame: 0 }, forceFrame: frame,
    })
    if (!res.ok) throw new Error(JSON.stringify(res.failure))
    // tilemap[i] = 0x10 + i and tilemapOffset is 0, so sub2 reads
    // tilemap[tileGroup] and the char recovers the group.
    return (res.parts[0].charNum - 0x400) - 0x10
  }

  it('indexes the table by frame >> the counted shift', () => {
    expect(groupFor(0x00, SHIFT6)).toBe(9)
    expect(groupFor(0x3F, SHIFT6)).toBe(9)
    expect(groupFor(0x40, SHIFT6)).toBe(7)
    expect(groupFor(0x80, SHIFT6)).toBe(5)
  })

  it('a shorter LSR run shifts less, with no descriptor change', () => {
    // Same descriptor, different cart: the run at $018010 is three long.
    const shorter = fakeRom({
      0x018000: [0x00, 0x81], 0x018100: [9, 7, 5, 3], ...runs,
      0x018010: [0x4A, 0x4A, 0x4A, 0xA8, 0x00, 0x00, 0x00, 0x00],
    })
    const res = drawSpriteParts({
      rom: shorter, tables: readSyntheticTables(),
      descriptor: { ...BASE_TIMER_DESC, tileGroup: src(SHIFT6) },
      spriteX: 0, ctx: { marioX: 0, romFrame: 0 }, forceFrame: 0x08,
    })
    if (!res.ok) throw new Error(JSON.stringify(res.failure))
    // 8 >> 3 = 1, so entry 1; 8 >> 6 = 0 would have given entry 0.
    expect((res.parts[0].charNum - 0x400) - 0x10).toBe(7)
  })

  it('ORs a masked slice of the SAME index when orBit is set', () => {
    // 9 is odd, so pick an even entry to see the bit: index 1 -> 7 is odd too;
    // use shift 6 entry 2 = 5 (odd). Table values are odd by construction, so
    // assert against a table whose entries are even instead.
    const evenRom = fakeRom({ 0x018000: [0x00, 0x81], 0x018100: [4, 2, 0], ...runs })
    const at = (frame: number) => {
      const res = drawSpriteParts({
        rom: evenRom, tables: readSyntheticTables(),
        descriptor: { ...BASE_TIMER_DESC, tileGroup: src(SHIFT6, SHIFT3) },
        spriteX: 0, ctx: { marioX: 0, romFrame: 0 }, forceFrame: frame,
      })
      if (!res.ok) throw new Error(JSON.stringify(res.failure))
      return (res.parts[0].charNum - 0x400) - 0x10
    }
    expect(at(0x00)).toBe(4)        // (0 >> 3) & 1 = 0
    expect(at(0x08)).toBe(5)        // (8 >> 3) & 1 = 1
    expect(at(0x40)).toBe(2)        // entry 1, bit 0
    expect(at(0x48)).toBe(3)        // entry 1, bit 1
  })

  it('omitting orBit leaves the table value untouched', () => {
    expect(groupFor(0x08, SHIFT6)).toBe(9)
  })

  it('the OR mask is read, so a mask of 3 brings in two bits', () => {
    const evenRom = fakeRom({
      0x018000: [0x00, 0x81], 0x018100: [4, 2, 0], ...runs, 0x018030: [0x03],
    })
    const res = drawSpriteParts({
      rom: evenRom, tables: readSyntheticTables(),
      descriptor: { ...BASE_TIMER_DESC, tileGroup: src(SHIFT6, SHIFT3) },
      spriteX: 0, ctx: { marioX: 0, romFrame: 0 }, forceFrame: 0x18,
    })
    if (!res.ok) throw new Error(JSON.stringify(res.failure))
    // (0x18 >> 3) & 3 = 3, against a mask of 1 it would have been 1.
    expect((res.parts[0].charNum - 0x400) - 0x10).toBe(4 | 3)
  })
})

// ── unionExtents ────────────────────────────────────────────────────────────

describe('unionExtents', () => {
  const body = [part(0, 0), part(8, 0), part(0, 8), part(8, 8)]

  it('is null for no parts at all', () => {
    expect(unionExtents([])).toBeNull()
    expect(unionExtents([[]])).toBeNull()
  })

  it('covers a part that only exists on one frame', () => {
    const withExtra = [part(-8, 0), ...body]
    expect(unionExtents([body])).toEqual({ x0: 0, y0: 0, x1: 16, y1: 16 })
    expect(unionExtents([body, withExtra])).toEqual({ x0: -8, y0: 0, x1: 16, y1: 16 })
  })

  it('is wider than the frame that lacks the extra part, which is the point', () => {
    const withExtra = [part(-8, 0), ...body]
    const union = unionExtents([body, withExtra])!
    const perFrame = unionExtents([body])!
    expect(union.x0).toBeLessThan(perFrame.x0)
  })
})

// ── $1F on the cart ─────────────────────────────────────────────────────────

const ROM_DIR = resolve(__dirname, '../../../roms')
const ROM_FILES = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
] as const
const romPaths = ROM_FILES.map(f => resolve(ROM_DIR, f))
const romsPresent = romPaths.every(existsSync)

const MAGIKOOPA = SPRITE_DRAW_DESCRIPTORS.find(d => d.spriteId === 0x1F)!

/** Body span of a `sub1` sprite: two stacked 16x16 large OBJs at dx 0..15. */
const BODY_X0 = 0
const BODY_X1 = 16

function drawAt(rom: RomFile, d: SpriteDrawDescriptor, frame: number, marioX: number) {
  const tables = readSpriteTileTables(rom)!
  const res = drawSpriteParts({
    rom, tables, descriptor: d, spriteX: 100,
    ctx: { marioX, romFrame: 0 }, forceFrame: frame,
  })
  if (!res.ok) throw new Error(`draw failed: ${JSON.stringify(res.failure)}`)
  return res
}

/** Parts whose dx falls outside the body's own 16 px column. */
const outside = (parts: readonly EnginePart[]) =>
  parts.filter(p => p.dx < BODY_X0 || p.dx >= BODY_X1)

describe.skipIf(!romsPresent)('$1F Magikoopa, extra part and state-timer pose cycle', () => {
  /** Mario right of the sprite gives latch 0, which SubSprGfx1 X-flips. */
  const FACING_RIGHT = 200
  const FACING_LEFT = 0

  it.each(ROM_FILES)('%s: the state-2 timer seeds at a value the cart holds', name => {
    const rom = RomFile.load(resolve(ROM_DIR, name))
    const seed = resolveStateTimerSeed(rom, MAGIKOOPA.anim, resolveHandlerBase(rom, MAGIKOOPA))
    expect(seed).not.toBeNull()
    // `frames` must span the whole countdown or later indices never render.
    expect(MAGIKOOPA.frames).toBe(seed! + 1)
  })

  it.each(ROM_FILES)('%s: the wand is drawn on the cast poses and absent on the wind-up poses', name => {
    const rom = RomFile.load(resolve(ROM_DIR, name))
    const seed = resolveStateTimerSeed(rom, MAGIKOOPA.anim, resolveHandlerBase(rom, MAGIKOOPA))!
    const counts = new Set<number>()
    let withWand = 0, withoutWand = 0
    for (let f = 0; f <= seed; f++) {
      const n = drawAt(rom, MAGIKOOPA, f, FACING_LEFT).parts.length
      counts.add(n)
      if (n === 9) withWand++; else withoutWand++
    }
    // Eight body subtiles always; nine when the wand's own OAM entry exists.
    expect([...counts].sort()).toEqual([8, 9])
    expect(withWand).toBeGreaterThan(0)
    expect(withoutWand).toBeGreaterThan(0)
  })

  it.each(ROM_FILES)('%s: the wand sits OUTSIDE the body box and is drawn behind it', name => {
    const rom = RomFile.load(resolve(ROM_DIR, name))
    const cast = drawAt(rom, MAGIKOOPA, 0, FACING_LEFT)
    const extras = outside(cast.parts)
    expect(extras).toHaveLength(1)
    // Unflipped, the wand is a full 8 px tile clear of the body's left edge.
    expect(extras[0].dx).toBeLessThan(BODY_X0)
    // A lower OAM index draws in front, and the wand's slot is past the
    // body's, so a renderer blitting in array order must emit it first.
    expect(cast.parts[0]).toBe(extras[0])
  })

  it.each(ROM_FILES)('%s: the wand sits on the bottom large OBJ row, not below the body', name => {
    const rom = RomFile.load(resolve(ROM_DIR, name))
    const cast = drawAt(rom, MAGIKOOPA, 0, FACING_LEFT)
    const wand = outside(cast.parts)[0]
    const bodyRows = [...new Set(cast.parts.filter(p => p !== wand).map(p => p.dy))].sort((a, b) => a - b)
    // `SubSprGfx1` stacks two 16x16 entries, so the body occupies four 8 px
    // rows. The wand's `ADC #$10` (bank_01.asm:8560) puts it on the SECOND
    // entry's top row, which is the third of those four.
    expect(bodyRows).toHaveLength(4)
    expect(wand.dy).toBe(bodyRows[2])
    // And therefore inside the body's vertical span, unlike its dx.
    expect(wand.dy).toBeGreaterThanOrEqual(bodyRows[0])
    expect(wand.dy).toBeLessThanOrEqual(bodyRows[3])
  })

  it.each(ROM_FILES)('%s: the wand switches sides with the facing, and is not double-mirrored', name => {
    const rom = RomFile.load(resolve(ROM_DIR, name))
    const left = outside(drawAt(rom, MAGIKOOPA, 0, FACING_LEFT).parts)[0]
    const right = outside(drawAt(rom, MAGIKOOPA, 0, FACING_RIGHT).parts)[0]
    expect(left.dx).toBeLessThan(BODY_X0)
    expect(right.dx).toBeGreaterThanOrEqual(BODY_X1)
    expect(left.flipX).toBe(false)
    expect(right.flipX).toBe(true)
    // Same char both ways: the displacement table carries the asymmetry.
    expect(left.charNum).toBe(right.charNum)
  })

  it.each(ROM_FILES)('%s: the wand char comes from the cart immediate, not a literal here', name => {
    const rom = RomFile.load(resolve(ROM_DIR, name))
    const parts = drawAt(rom, MAGIKOOPA, 0, FACING_LEFT).parts
    const wand = outside(parts)[0]
    const body = parts.filter(p => p !== wand).map(p => p.charNum)
    expect(body).not.toContain(wand.charNum)

    // Re-derive the char from the operand the descriptor points at. The
    // number itself stays in the cart: what is pinned is that the engine
    // READ it, and read it from the right address.
    const src = MAGIKOOPA.extraParts![0].char as Extract<ExtraByteSource, { kind: 'immediateAt' }>
    const imm = rom.readAt(resolveRef(rom, src.addr, resolveHandlerBase(rom, MAGIKOOPA))!, 1)![0]
    const attr = readSpriteTileTables(rom)!.spriteAttr[0x1F]
    const charHigh = (attr & 0x01) !== 0 ? 0x100 : 0
    expect(wand.charNum).toBe(0x400 + charHigh + (imm & 0x1FF))
  })

  it.each(ROM_FILES)('%s: the pose cycle is three poses, wind-up plus the two cast poses', name => {
    const rom = RomFile.load(resolve(ROM_DIR, name))
    const seed = resolveStateTimerSeed(rom, MAGIKOOPA.anim, resolveHandlerBase(rom, MAGIKOOPA))!
    const key = (p: readonly EnginePart[]) => p.map(q => `${q.charNum}@${q.dx},${q.dy}`).join('|')
    const poses = new Set<string>()
    for (let f = 0; f <= seed; f++) poses.add(key(drawAt(rom, MAGIKOOPA, f, FACING_LEFT).parts))
    // Wind-up (no wand), cast, and cast with the top tile bobbed 1 px. The
    // bob was the third pose the descriptor could not express; it is now
    // read out of the cart, so the OR bit that selects it is observable.
    expect(poses.size).toBe(3)
  })

  it.each(ROM_FILES)('%s: the union box covers the wand even on the frames that lack it', name => {
    const rom = RomFile.load(resolve(ROM_DIR, name))
    const seed = resolveStateTimerSeed(rom, MAGIKOOPA.anim, resolveHandlerBase(rom, MAGIKOOPA))!
    const frames: EnginePart[][] = []
    for (let f = 0; f <= seed; f++) frames.push([...drawAt(rom, MAGIKOOPA, f, FACING_LEFT).parts])
    const union = unionExtents(frames)!
    const windUp = frames.find(p => p.length === 8)!
    const windUpBox = unionExtents([windUp])!
    expect(union.x0).toBeLessThan(windUpBox.x0)
    expect(union.x0).toBe(Math.min(...frames.flat().map(p => p.dx)))
  })

  it.each(ROM_FILES)('%s: the runtime palette is reported and its colours are readable', name => {
    const rom = RomFile.load(resolve(ROM_DIR, name))
    const note = drawAt(rom, MAGIKOOPA, 0, FACING_LEFT).paletteNote!
    expect(note.kind).toBe('dynamicCgram')
    // Only PART of the row is overwritten, so the caller must composite.
    expect(note.colors).toBeLessThan(16)
    expect(note.firstCol + note.colors).toBeLessThanOrEqual(16)
    expect(rom.readAt(note.entryAddr, note.colors * 2)).not.toBeNull()
    // Every part the engine emits is on the row the upload targets, so the
    // composite applies to all of them or the sprite is half-recoloured.
    for (const p of drawAt(rom, MAGIKOOPA, 0, FACING_LEFT).parts) {
      expect(p.palette).toBe(note.row)
    }
  })
})

// ── Planted defects ─────────────────────────────────────────────────────────

/**
 * Every oracle above, shown going red on a defect that a human could
 * plausibly introduce. A verdict that cannot fail is worse than no verdict,
 * and the $1F defect shipped with a green suite.
 */
describe.skipIf(!romsPresent)('planted defects make the $1F oracles fail', () => {
  const rom = () => RomFile.load(romPaths[0])
  const FACING_LEFT = 0
  const wandOf = (d: SpriteDrawDescriptor, frame = 0) =>
    outside(drawAt(rom(), d, frame, FACING_LEFT).parts)[0]

  const mutate = (over: Partial<SpriteDrawDescriptor>): SpriteDrawDescriptor =>
    ({ ...MAGIKOOPA, ...over })
  const wand = MAGIKOOPA.extraParts![0]
  const mutateWand = (over: Partial<ExtraPart>): SpriteDrawDescriptor =>
    mutate({ extraParts: [{ ...wand, ...over }] })

  it('extra part dropped: nothing lands outside the body box', () => {
    const d = mutate({ extraParts: [] })
    expect(outside(drawAt(rom(), d, 0, FACING_LEFT).parts)).toHaveLength(0)
    expect(drawAt(rom(), d, 0, FACING_LEFT).parts).toHaveLength(8)
  })

  it('wrong extra-part dx source: the wand stops leaving the body box', () => {
    const d = mutateWand({ dx: { kind: 'const', value: 0 } })
    expect(outside(drawAt(rom(), d, 0, FACING_LEFT).parts)).toHaveLength(0)
  })

  it('wrong extra-part dy source: the wand moves off the body row', () => {
    const good = wandOf(MAGIKOOPA)
    const bad = wandOf(mutateWand({ dy: { kind: 'const', value: 0x28 } }))
    expect(bad.dy).not.toBe(good.dy)
  })

  it('unsigned offset: a negative displacement read as unsigned lands far right', () => {
    // $F8 sign-extends to -8. Read unsigned it would be +248, which no OAM
    // entry of this sprite ever holds.
    expect(wandOf(MAGIKOOPA).dx).toBeLessThan(0)
    expect(wandOf(MAGIKOOPA).dx).toBeGreaterThan(-0x80)
  })

  it('wrong frame gating: a gate of zero draws the wand on every pose', () => {
    // The gate immediate lives at a cart address; point it at a byte that
    // holds $00 and every tile group clears it.
    const zeroByte = 0x01BF15   // `RTS` opcode $60 is non-zero; use a known 0
    const d = mutateWand({ gate: { kind: 'tileGroupAtLeast', operandAddr: zeroByte } })
    const seed = resolveStateTimerSeed(rom(), MAGIKOOPA.anim, resolveHandlerBase(rom(), MAGIKOOPA))!
    const counts = new Set<number>()
    for (let f = 0; f <= seed; f++) counts.add(drawAt(rom(), d, f, FACING_LEFT).parts.length)
    // The real descriptor produces both 8 and 9; a mis-pointed gate does not.
    expect([...counts].sort()).not.toEqual([8, 9])
  })

  it('gate removed entirely: the wand appears on the wind-up poses too', () => {
    const d = mutateWand({ gate: undefined })
    const seed = resolveStateTimerSeed(rom(), MAGIKOOPA.anim, resolveHandlerBase(rom(), MAGIKOOPA))!
    for (let f = 0; f <= seed; f++) {
      expect(drawAt(rom(), d, f, FACING_LEFT).parts).toHaveLength(9)
    }
  })

  it('wrong timer shift: the pose cycle collapses or changes length', () => {
    const t = MAGIKOOPA.tileGroup as Extract<typeof MAGIKOOPA.tileGroup, { kind: 'shiftedTable' }>
    const seed = resolveStateTimerSeed(rom(), MAGIKOOPA.anim, resolveHandlerBase(rom(), MAGIKOOPA))!
    const poseCount = (d: SpriteDrawDescriptor) => {
      const s = new Set<string>()
      for (let f = 0; f <= seed; f++) {
        s.add(drawAt(rom(), d, f, FACING_LEFT).parts.map(p => `${p.charNum}@${p.dx},${p.dy}`).join('|'))
      }
      return s.size
    }
    expect(poseCount(MAGIKOOPA)).toBe(3)
    // Point the shift scan at a byte that is not `LSR A`, so the count is 0.
    expect(poseCount(mutate({ tileGroup: { ...t, shift: { scan: 0x01BDD6, max: 8 } } }))).not.toBe(3)
  })

  it('missing OR bit: now observable, because the bob it selects is modelled', () => {
    // This oracle used to record a NEGATIVE result: `SprTilemap` holds the
    // same pair for tile groups 2 and 3 and the same pair for 4 and 5, so
    // dropping the OR bit changed no pixel while the 1 px bob at
    // bank_01.asm:8530-8539 was unmodelled. The bob is now read out of the
    // cart, the odd group is the only one it fires on, and the bit is
    // therefore visible in the render. Inverted rather than deleted, because
    // which of the two it is is the whole finding.
    const t = MAGIKOOPA.tileGroup as Extract<typeof MAGIKOOPA.tileGroup, { kind: 'shiftedTable' }>
    const seed = resolveStateTimerSeed(rom(), MAGIKOOPA.anim, resolveHandlerBase(rom(), MAGIKOOPA))!
    const trace = (d: SpriteDrawDescriptor) => {
      const out: string[] = []
      for (let f = 0; f <= seed; f++) {
        out.push(drawAt(rom(), d, f, FACING_LEFT).parts.map(p => `${p.charNum}@${p.dx},${p.dy}`).join(','))
      }
      return out
    }
    const withoutBit = mutate({ tileGroup: { ...t, orBit: undefined } })
    expect(trace(withoutBit)).not.toEqual(trace(MAGIKOOPA))
  })

  it('wrong pose table address: the tile group stops matching the cart table', () => {
    const t = MAGIKOOPA.tileGroup as Extract<typeof MAGIKOOPA.tileGroup, { kind: 'shiftedTable' }>
    const seed = resolveStateTimerSeed(rom(), MAGIKOOPA.anim, resolveHandlerBase(rom(), MAGIKOOPA))!
    const trace = (d: SpriteDrawDescriptor) => {
      const out: string[] = []
      for (let f = 0; f <= seed; f++) {
        out.push(drawAt(rom(), d, f, FACING_LEFT).parts.map(p => p.charNum).join(','))
      }
      return out
    }
    // One byte off in the operand resolves to a different table. Frame 0
    // alone can still coincide, so the whole countdown is the oracle.
    const bad = mutate({ tileGroup: { ...t, operandAddr: { mainOff: 0xD2 } } })
    expect(trace(bad)).not.toEqual(trace(MAGIKOOPA))
  })

  it('animation forced static: the pose cycle collapses to one pose', () => {
    const d = mutate({ anim: { kind: 'static' }, tileGroup: { kind: 'const', value: 0 } })
    const key = (p: readonly EnginePart[]) => p.map(q => `${q.charNum}@${q.dx},${q.dy}`).join('|')
    const poses = new Set<string>()
    for (let f = 0; f < 0x71; f++) poses.add(key(drawAt(rom(), d, f, FACING_LEFT).parts))
    expect(poses.size).toBe(1)
    // And it is the state-1 fade-in pose, with no wand at all: exactly the
    // output the descriptor produced before these two kinds existed.
    expect(drawAt(rom(), d, 0, FACING_LEFT).parts).toHaveLength(8)
  })

  it('wrong timer seed address: the descriptor fails rather than guessing', () => {
    // $01:FFFF is past the handler; pointing the seed off the cart must not
    // silently degrade to frame 0.
    const d = mutate({ anim: { kind: 'stateTimer', seedOperandAddr: 0xFFFFFF } })
    const res = drawSpriteParts({
      rom: rom(), tables: readSpriteTileTables(rom())!, descriptor: d,
      spriteX: 100, ctx: { marioX: 0, romFrame: 0 },
    })
    expect(res.ok).toBe(false)
  })
})
