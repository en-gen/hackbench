/**
 * Values the $1F descriptor used to HOLD and now READS from the open cart.
 *
 * Every test here plants a different byte in an in-memory copy of a real cart
 * and proves the render follows it. That is the whole standard: if changing
 * the cart byte does not change the output, the engine did not read it, and a
 * descriptor field that merely records what vanilla happens to hold is a
 * hardcoded derivation wearing an address.
 *
 * Four conversions are covered:
 *   shift counts     - counted as a run of `LSR A` opcodes, not stored
 *   the 1 px bob     - displacement, sign, target entry and gates all read
 *   handler anchoring- offsets past the cart's own MAIN handler pointer
 *   routine choice   - read from the `JSR` target, matched to the three
 *                      shared routine entry points
 *
 * Nothing is written to disk: `RomFile.writeAt` mutates the loaded buffer.
 *
 * Evidence scope: the planted-byte tests run on
 * `Super Mario World (USA).vanilla.sfc`; the "vanilla holds N" tests run on
 * all six carts in the corpus. Static traces against `C:\Projects\SMWDisX`.
 * No emulator was run.
 */

import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { readSpriteTileTables, SPR_TILEMAP_ADDR } from '../../../../src/rom/SpriteTileLoader'
import {
  SPRITE_DRAW_DESCRIPTORS,
  SPRITE_MAIN_PTR_TABLE,
  SHARED_DRAW_ROUTINES,
  type ByteSource,
  type CodeRef,
  type SpriteDrawDescriptor,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawDescriptor'
import {
  drawSpriteParts,
  resolveHandlerBase,
  resolveRef,
  readShiftCount,
  resolveStateTimerSeed,
  type EnginePart,
  type EngineResult,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'
import { CORPUS, freshRom, hasRoms } from '../../support/corpus'

const romsPresent = hasRoms()

const MAGIKOOPA = SPRITE_DRAW_DESCRIPTORS.find(d => d.spriteId === 0x1f)!

/** `resolveRef` that throws instead of returning null, so a test that plants
 *  a byte at a ref the cart cannot resolve fails loudly rather than writing
 *  to address 0. */
function refAt(rom: RomFile, ref: CodeRef, base: number): number {
  const at = resolveRef(rom, ref, base)
  if (at === null) throw new Error('CodeRef did not resolve')
  return at
}

/** A fresh in-memory cart per test, so a planted byte never leaks sideways. */

/** Mario left of the sprite: latch 1, so `SubSprGfx1` does not X-flip. */
const FACING_LEFT = 0

function draw(rom: RomFile, frame: number, d: SpriteDrawDescriptor = MAGIKOOPA): EngineResult {
  return drawSpriteParts({
    rom,
    tables: readSpriteTileTables(rom)!,
    descriptor: d,
    spriteX: 100,
    ctx: { marioX: FACING_LEFT, romFrame: 0 },
    forceFrame: frame,
  })
}

function parts(rom: RomFile, frame: number, d: SpriteDrawDescriptor = MAGIKOOPA): EnginePart[] {
  const res = draw(rom, frame, d)
  if (!res.ok) throw new Error(`draw failed: ${JSON.stringify(res.failure)}`)
  return res.parts
}

/** The routine's OWN subtiles: the wand is an extra part the handler writes
 *  itself and sits a whole tile clear of the body's 16 px column. */
const bodyOf = (p: readonly EnginePart[]) => p.filter(q => q.dx >= 0 && q.dx < 16)

/** Distinct 8 px rows the body occupies, low to high. */
const bodyRows = (p: readonly EnginePart[]) =>
  [...new Set(bodyOf(p).map(q => q.dy))].sort((a, b) => a - b)

const poseKey = (p: readonly EnginePart[]) => p.map(q => `${q.charNum}@${q.dx},${q.dy}`).join('|')

/** Distinct drawn poses over the whole state-2 countdown. */
function poses(rom: RomFile, d: SpriteDrawDescriptor = MAGIKOOPA): string[] {
  const seed = resolveStateTimerSeed(rom, d.anim, resolveHandlerBase(rom, d))!
  const out = new Set<string>()
  for (let f = 0; f <= seed; f++) out.add(poseKey(parts(rom, f, d)))
  return [...out].sort()
}

/** Frames on which the routine's TOP large OBJ is displaced vertically,
 *  with the displacement. The bob is the only thing that moves it. */
function nudgedFrames(rom: RomFile, d: SpriteDrawDescriptor = MAGIKOOPA): Map<number, number> {
  const seed = resolveStateTimerSeed(rom, d.anim, resolveHandlerBase(rom, d))!
  // The body's own top row, taken from a frame the vanilla gate cannot reach.
  const restDy = Math.min(...parts(rom, 0, d).map(p => p.dy))
  const hits = new Map<number, number>()
  for (let f = 0; f <= seed; f++) {
    const dy = Math.min(...parts(rom, f, d).map(p => p.dy))
    if (dy !== restDy) hits.set(f, dy - restDy)
  }
  return hits
}

// ── 1. Shift counts, counted out of the cart ────────────────────────────────

const TILE_GROUP = MAGIKOOPA.tileGroup as Extract<ByteSource, { kind: 'shiftedTable' }>

describe.skipIf(!romsPresent)('shift counts are counted, not stored', () => {
  it.each(CORPUS)('%s: the pose-table index shift is a run of six LSR A', name => {
    const rom = freshRom(name)
    expect(readShiftCount(rom, TILE_GROUP.shift, resolveHandlerBase(rom, MAGIKOOPA))).toBe(6)
  })

  it.each(CORPUS)('%s: the OR-bit slice is a run of three LSR A', name => {
    const rom = freshRom(name)
    expect(readShiftCount(rom, TILE_GROUP.orBit!.shift, resolveHandlerBase(rom, MAGIKOOPA))).toBe(3)
  })

  it('a planted seventh LSR A is counted, and changes the pose cycle', () => {
    const rom = freshRom()
    const before = poses(rom)
    // `TAY` at the end of the run becomes one more `LSR A`.
    const base = resolveHandlerBase(rom, MAGIKOOPA)
    rom.writeAt(refAt(rom, TILE_GROUP.shift.scan, base) + 6, [0x4a])
    expect(readShiftCount(rom, TILE_GROUP.shift, base)).toBe(7)
    expect(poses(rom)).not.toEqual(before)
  })

  it('the scan stops at the first non-LSR byte, and does not run past it', () => {
    const rom = freshRom()
    const base = resolveHandlerBase(rom, MAGIKOOPA)
    rom.writeAt(refAt(rom, TILE_GROUP.shift.scan, base) + 3, [0xea]) // NOP
    expect(readShiftCount(rom, TILE_GROUP.shift, base)).toBe(3)
  })

  it('a run of zero reads as zero rather than as the vanilla count', () => {
    const rom = freshRom()
    const base = resolveHandlerBase(rom, MAGIKOOPA)
    rom.writeAt(refAt(rom, TILE_GROUP.shift.scan, base), [0xea])
    expect(readShiftCount(rom, TILE_GROUP.shift, base)).toBe(0)
  })

  it('a planted fourth LSR A in the OR-bit slice changes which poses bob', () => {
    const rom = freshRom()
    const before = [...nudgedFrames(rom).keys()]
    const base = resolveHandlerBase(rom, MAGIKOOPA)
    // The `AND #$01` opcode becomes one more `LSR A`, so the slice moves up
    // a bit and the odd tile group lands on different timer values.
    rom.writeAt(refAt(rom, TILE_GROUP.orBit!.shift.scan, base) + 3, [0x4a])
    expect(readShiftCount(rom, TILE_GROUP.orBit!.shift, base)).toBe(4)
    expect([...nudgedFrames(rom).keys()]).not.toEqual(before)
  })

  it('the OR mask is read from the AND immediate, not assumed to be one', () => {
    const rom = freshRom()
    const before = poses(rom)
    const base = resolveHandlerBase(rom, MAGIKOOPA)
    rom.writeAt(refAt(rom, TILE_GROUP.orBit!.maskAddr, base), [0x03])
    // Two bits ORed in reach tile groups the vanilla cycle never selects, so
    // `SubSprGfx1` reads a different pair out of `SprTilemap`.
    expect(poses(rom)).not.toEqual(before)
  })
})

// ── 2. The 1 px bob ─────────────────────────────────────────────────────────

const NUDGE = MAGIKOOPA.tileNudges![0]

describe.skipIf(!romsPresent)('the 1 px top-tile bob is read out of the cart', () => {
  it.each(CORPUS)('%s: exactly one pose class is displaced, by +1 px', name => {
    const rom = freshRom(name)
    const hits = nudgedFrames(rom)
    expect(hits.size).toBeGreaterThan(0)
    expect([...new Set(hits.values())]).toEqual([1])
  })

  it.each(CORPUS)('%s: only the TOP large OBJ moves, not the whole sprite', name => {
    const rom = freshRom(name)
    const f = [...nudgedFrames(rom).keys()][0]
    const rows = bodyRows(parts(rom, f))
    const rest = bodyRows(parts(rom, 0))
    // `SubSprGfx1`'s top entry is two 8 px rows; the bottom entry stays put.
    expect(rows.slice(0, 2)).toEqual(rest.slice(0, 2).map(r => r + 1))
    expect(rows.slice(2)).toEqual(rest.slice(2))
  })

  it('the pose cycle is three poses, not two, now the bob is modelled', () => {
    expect(poses(freshRom())).toHaveLength(3)
  })

  it('the displacement comes from the opcode: DEC abs,X reads as -1', () => {
    const rom = freshRom()
    rom.writeAt(refAt(rom, NUDGE.insnAddr, resolveHandlerBase(rom, MAGIKOOPA)), [0xde])
    expect([...new Set(nudgedFrames(rom).values())]).toEqual([-1])
  })

  it('an opcode that is neither INC nor DEC abs,X is refused, not guessed', () => {
    const rom = freshRom()
    rom.writeAt(refAt(rom, NUDGE.insnAddr, resolveHandlerBase(rom, MAGIKOOPA)), [0xea])
    const f = [...nudgedFrames(freshRom()).keys()][0]
    const res = draw(rom, f)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.failure.kind).toBe('unexpectedOpcode')
  })

  it('the target entry comes from the operand: $0305 moves the BOTTOM OBJ', () => {
    const rom = freshRom()
    const f = [...nudgedFrames(freshRom()).keys()][0]
    rom.writeAt(refAt(rom, NUDGE.insnAddr, resolveHandlerBase(rom, MAGIKOOPA)) + 1, [0x05, 0x03])
    const rows = bodyRows(parts(rom, f))
    const rest = bodyRows(parts(rom, 0))
    expect(rows.slice(0, 2)).toEqual(rest.slice(0, 2))
    expect(rows.slice(2)).toEqual(rest.slice(2).map(r => r + 1))
  })

  it("an operand pointing outside the routine's own entries is refused", () => {
    const rom = freshRom()
    const f = [...nudgedFrames(freshRom()).keys()][0]
    rom.writeAt(refAt(rom, NUDGE.insnAddr, resolveHandlerBase(rom, MAGIKOOPA)) + 1, [0x09, 0x03])
    const res = draw(rom, f)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.failure.kind).toBe('nudgeTargetOutOfRange')
  })

  it('the window base is read: moving it changes which poses bob', () => {
    const rom = freshRom()
    const before = [...nudgedFrames(rom).keys()]
    rom.writeAt(refAt(rom, NUDGE.windowBase, resolveHandlerBase(rom, MAGIKOOPA)), [0x00])
    expect([...nudgedFrames(rom).keys()]).not.toEqual(before)
  })

  it('the window size is read: a size of zero widens the gate', () => {
    const rom = freshRom()
    const before = nudgedFrames(rom).size
    rom.writeAt(refAt(rom, NUDGE.windowSize, resolveHandlerBase(rom, MAGIKOOPA)), [0x00])
    expect(nudgedFrames(rom).size).toBeGreaterThan(before)
  })

  it('the odd-only bit test is a counted LSR run: removing it widens the gate', () => {
    const rom = freshRom()
    const before = nudgedFrames(rom).size
    const base = resolveHandlerBase(rom, MAGIKOOPA)
    rom.writeAt(refAt(rom, NUDGE.bitSelect.scan, base), [0xea])
    expect(readShiftCount(rom, NUDGE.bitSelect, base)).toBe(0)
    expect(nudgedFrames(rom).size).toBeGreaterThan(before)
  })
})

// ── 3. Handler-relative anchoring ───────────────────────────────────────────

/** Byte span of the handler the descriptor's `{ mainOff }` refs cover. */
const SPAN_FROM = 0xc0
const SPAN_TO = 0x262

describe.skipIf(!romsPresent)('per-handler addresses follow the cart pointer', () => {
  it.each(CORPUS)('%s: the base is the MAIN pointer the cart holds', name => {
    const rom = freshRom(name)
    const ptr = rom.readAt(SPRITE_MAIN_PTR_TABLE + 0x1f * 2, 2)!
    expect(resolveHandlerBase(rom, MAGIKOOPA)).toBe(0x010000 | (ptr[0] | (ptr[1] << 8)))
  })

  it('a RELOCATED handler still renders identically', () => {
    const before = poses(freshRom())
    const rom = freshRom()
    const base = resolveHandlerBase(rom, MAGIKOOPA) & 0xffff
    const moved = base + 0x100
    // Snapshot first: source and destination overlap.
    const body = Buffer.from(rom.readAt(0x010000 | (base + SPAN_FROM), SPAN_TO - SPAN_FROM)!)
    rom.writeAt(SPRITE_MAIN_PTR_TABLE + 0x1f * 2, [moved & 0xff, moved >> 8])
    rom.writeAt(0x010000 | (moved + SPAN_FROM), body)
    expect(poses(rom)).toEqual(before)
  })

  it('and the old location is no longer what is read', () => {
    const before = poses(freshRom())
    const rom = freshRom()
    const base = resolveHandlerBase(rom, MAGIKOOPA) & 0xffff
    const moved = base + 0x100
    // Repoint WITHOUT moving the code: every offset now lands on unrelated
    // bytes, which an absolute-addressed descriptor would never notice.
    rom.writeAt(SPRITE_MAIN_PTR_TABLE + 0x1f * 2, [moved & 0xff, moved >> 8])
    const after = draw(rom, 0)
    expect(after.ok === false || poses(rom).join() !== before.join()).toBe(true)
  })
})

// ── 4. The routine choice, read from the JSR target ─────────────────────────

describe.skipIf(!romsPresent)('the shared routine is read from the JSR target', () => {
  const sub = (n: 'sub0' | 'sub1' | 'sub2') => SHARED_DRAW_ROUTINES.find(r => r.routine === n)!.addr

  it.each(CORPUS)('%s: the cart holds a JSR to SubSprGfx1', name => {
    const rom = freshRom(name)
    const at = refAt(rom, MAGIKOOPA.routineJsr!, resolveHandlerBase(rom, MAGIKOOPA))
    const b = rom.readAt(at, 3)!
    expect(b[0]).toBe(0x20)
    expect(b[1] | (b[2] << 8)).toBe(sub('sub1'))
  })

  it('the descriptor field does NOT decide it: a lying `routine` is ignored', () => {
    // `sub1` stacks two large OBJs, so eight body subtiles. `sub2` draws one.
    const body = parts(freshRom(), 0, { ...MAGIKOOPA, routine: 'sub2' }).filter(
      p => p.dx >= 0 && p.dx < 16,
    )
    expect(body).toHaveLength(8)
  })

  it('a JSR retargeted at SubSprGfx2Entry1 renders one large OBJ', () => {
    const rom = freshRom()
    const at = refAt(rom, MAGIKOOPA.routineJsr!, resolveHandlerBase(rom, MAGIKOOPA))
    rom.writeAt(at + 1, [sub('sub2') & 0xff, sub('sub2') >> 8])
    expect(parts(rom, 0).filter(p => p.dx >= 0 && p.dx < 16)).toHaveLength(4)
  })

  it('a JSR retargeted at SubSprGfx0Entry0 renders four independent chars', () => {
    const rom = freshRom()
    const at = refAt(rom, MAGIKOOPA.routineJsr!, resolveHandlerBase(rom, MAGIKOOPA))
    rom.writeAt(at + 1, [sub('sub0') & 0xff, sub('sub0') >> 8])
    expect(parts(rom, 0).filter(p => p.dx >= 0 && p.dx < 16)).toHaveLength(4)
  })

  it('a JSR to code nobody has traced is refused, not rendered confidently', () => {
    const rom = freshRom()
    const at = refAt(rom, MAGIKOOPA.routineJsr!, resolveHandlerBase(rom, MAGIKOOPA))
    rom.writeAt(at + 1, [0x34, 0x12])
    const res = draw(rom, 0)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.failure.kind).toBe('unknownDrawRoutine')
  })

  it('an instruction that is not a JSR at all is refused', () => {
    const rom = freshRom()
    const at = refAt(rom, MAGIKOOPA.routineJsr!, resolveHandlerBase(rom, MAGIKOOPA))
    rom.writeAt(at, [0xea])
    const res = draw(rom, 0)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.failure.kind).toBe('unexpectedOpcode')
  })
})

// ── 5. $2C's tile comes from the ASM immediate, not the tilemap ─────────────

/**
 * `CODE_01F78D` calls `SubSprGfx2Entry1` and then overwrites the tile the
 * routine just wrote with an `LDA #$00` immediate (bank_01.asm:16057-16062).
 * So `SprTilemapOffset[$2C]` is a source the ROM discards, and the descriptor
 * used to read it.
 *
 * Vanilla COINCIDES, because `SprTilemap[$94]` is $00 as well, which is why a
 * whole-cart equivalence run could not see the difference. The two plants
 * below separate the sources: one moves the tilemap and requires the render
 * NOT to follow, the other moves the immediate and requires that it does.
 */
describe.skipIf(!romsPresent)('$2C draws the immediate the handler writes', () => {
  const EGG = SPRITE_DRAW_DESCRIPTORS.find(d => d.spriteId === 0x2c)!
  const eggChars = (rom: RomFile) =>
    parts(rom, 0, EGG)
      .map(p => p.charNum)
      .join(',')
  const immAt = (rom: RomFile) =>
    refAt(rom, EGG.tileOverrides![0].insnAddr, resolveHandlerBase(rom, EGG)) + 1

  it.each(CORPUS)('%s: the override is an LDA #$00 right after the JSR', name => {
    const rom = freshRom(name)
    const at = refAt(rom, EGG.tileOverrides![0].insnAddr, resolveHandlerBase(rom, EGG))
    expect(rom.readAt(at, 2)![0]).toBe(0xa9) // LDA #imm
    expect(rom.readAt(at, 2)![1]).toBe(0x00)
    // And the `JSR SubSprGfx2Entry1` the override follows.
    const jsr = refAt(rom, EGG.routineJsr!, resolveHandlerBase(rom, EGG))
    const b = rom.readAt(jsr, 3)!
    expect(b[0]).toBe(0x20)
    expect(SHARED_DRAW_ROUTINES.find(r => r.addr === (b[1] | (b[2] << 8)))?.routine).toBe('sub2')
  })

  it('moving the immediate moves the drawn chars', () => {
    const rom = freshRom()
    const before = eggChars(rom)
    rom.writeAt(immAt(rom), [0x60])
    expect(eggChars(rom)).not.toBe(before)
    // At spriteX 100 the egg's attribute is `YoshiPal[(100 >> 4) & 3]` = $05,
    // whose bit 0 is the char-high bit, so base $60 expands through the
    // large-OBJ corners onto chars $560, $561, $570, $571.
    expect(
      parts(rom, 0, EGG)
        .map(p => p.charNum)
        .sort((a, b) => a - b),
    ).toEqual([0x560, 0x561, 0x570, 0x571])
  })

  it('moving the TILEMAP byte does not, because the ROM discards it', () => {
    // The planted byte is the one the old descriptor read. If this ever goes
    // red the engine has gone back to the source `CODE_01F78D` throws away.
    const rom = freshRom()
    const tables = readSpriteTileTables(rom)!
    const before = eggChars(rom)
    rom.writeAt(SPR_TILEMAP_ADDR + tables.tilemapOffset[0x2c], [0x60])
    expect(eggChars(rom)).toBe(before)
  })

  it('an override instruction that is not an LDA #imm is refused', () => {
    const rom = freshRom()
    rom.writeAt(refAt(rom, EGG.tileOverrides![0].insnAddr, resolveHandlerBase(rom, EGG)), [0xea])
    const res = draw(rom, 0, EGG)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.failure.kind).toBe('unexpectedOpcode')
  })
})

// ── 6. $1F sits where SubSprGfx1 puts it ───────────────────────────────────

describe.skipIf(!romsPresent)("$1F is anchored on the routine's first OAM entry", () => {
  it.each(CORPUS)('%s: the body occupies rows 0..31, not -16..15', name => {
    // `SubSprGfx1` stores `_1` to `OAMTileYPos+$100` and `_1 + $10` to
    // `+$104` (bank_01.asm:3948-3952), so its origin is the TOP entry.
    //
    // $1F has NO handler Y adjust: bank_01.asm:8513-8529 computes its tile
    // group and calls the routine with no `SBC` on `SpriteYPosLow` in
    // between, unlike `Spr0to13Gfx`'s 16x32 branch (bank_01.asm:1774). So
    // nothing shifts it and the body starts at the sprite's own Y.
    //
    // The engine used to anchor `drawSub1` on the BOTTOM entry and carry a
    // `ROUTINE_BASE_DY` constant to undo that. The walk family cancelled it
    // out through its own Y adjust; $1F, having none, rendered 16 px high.
    const rom = freshRom(name)
    expect(bodyRows(parts(rom, 0))).toEqual([0, 8, 16, 24])
  })

  it.each(CORPUS)('%s: the 1 px nudge still lands on the TOP entry', name => {
    // Re-anchoring must not move which entry `INC OAMTileYPos+$100`
    // (bank_01.asm:8539) targets: `+$100` is the routine's first, which is
    // the top one either way.
    const rom = freshRom(name)
    const nudged = [...nudgedFrames(rom).values()]
    expect(nudged.length).toBeGreaterThan(0)
    expect(new Set(nudged)).toEqual(new Set([1]))
  })
})

// ── 7. The dynamic palette's resting entry, read from the fade terminator ──

/**
 * `CODE_01C004` counts `SpriteMisc1570` up and uploads entry `counter - 1`
 * each step (bank_01.asm:8734-8740). The `CMP #$09` at $01:C01C ends the fade
 * by advancing the state instead of uploading (bank_01.asm:8726-8730), so the
 * entries written are 0..7 and the one left standing in CGRAM is 7.
 *
 * `restingEntry: 7` was a literal on the branch whose whole purpose is
 * reading. It is now the fallback, and the immediate decides.
 */
describe.skipIf(!romsPresent)("$1F's resting palette entry is read, not held", () => {
  const cmpAt = (rom: RomFile) => {
    const src = MAGIKOOPA.palette as Extract<typeof MAGIKOOPA.palette, { kind: 'dynamicCgram' }>
    return refAt(rom, src.restingEntryCmpAddr!, resolveHandlerBase(rom, MAGIKOOPA))
  }
  const entryAddr = (rom: RomFile) => {
    const res = draw(rom, 0)
    if (!res.ok || !res.paletteNote) throw new Error('no palette note')
    return res.paletteNote.entryAddr
  }

  it.each(CORPUS)('%s: the terminator is CMP #$09 and the entry resolves to 7', name => {
    const rom = freshRom(name)
    expect(rom.readAt(cmpAt(rom), 2)![0]).toBe(0xc9) // CMP #imm
    expect(rom.readAt(cmpAt(rom), 2)![1]).toBe(0x09)
    // entry 7 of 8 colours, 2 bytes each, past the table base.
    const base = entryAddr(rom) - 7 * 8 * 2
    expect(entryAddr(rom)).toBe(base + 7 * 16)
  })

  it('shortening the fade moves the entry the editor composites', () => {
    const rom = freshRom()
    const before = entryAddr(rom)
    rom.writeAt(cmpAt(rom), [0xc9, 0x05]) // fade ends at entry 3
    expect(entryAddr(rom)).toBe(before - 4 * 16)
  })

  it('an unrecognised terminator falls back to the descriptor literal', () => {
    // A fallback, not a failure: the colours are a still editor's
    // approximation of a runtime DMA either way, and declining to draw $1F
    // over this would lose a sprite the engine renders correctly.
    const rom = freshRom()
    const before = entryAddr(rom)
    // The second byte must imply a DIFFERENT entry, or the assertion passes
    // whether the opcode is checked or not. Planting `[0xEA]` alone left the
    // old $09 in place and a mutant that skipped the opcode check survived.
    rom.writeAt(cmpAt(rom), [0xea, 0x05])
    expect(entryAddr(rom)).toBe(before)
  })

  it('an out-of-range immediate falls back too, in both directions', () => {
    const rom = freshRom()
    const before = entryAddr(rom)
    rom.writeAt(cmpAt(rom), [0xc9, 0x01]) // imm - 2 = -1
    expect(entryAddr(rom)).toBe(before)
    rom.writeAt(cmpAt(rom), [0xc9, 0x0b]) // imm - 2 = 9 >= 8
    expect(entryAddr(rom)).toBe(before)
    rom.writeAt(cmpAt(rom), [0xc9, 0x0a]) // imm - 2 = 8, still past the end
    expect(entryAddr(rom)).toBe(before)
  })
})

// ── 8. $14, $4D and $4E: the bespoke three, converted ──────────────────────

/**
 * The headline claim was "reads rather than hardcodes", and it held for $1F
 * and the eleven walk descriptors while being largely false for the rest:
 * their draw `JSR` targets, `LDA #imm` operands and table operands were all
 * ignored although readable at fixed offsets, and this file covered $1F only.
 *
 * What is converted here, with the plant that proves each:
 *
 *   $14  draw `JSR`, the `LDA #$02` prop group, the animation shift and mask
 *   $4D  draw `JSR`, both table ADDRESSES from their `LDA abs,Y` operands
 *   $4E  draw `JSR`, the `LDA #$03` tile group
 *
 * What is NOT, and is listed in docs/sprites/sprite-engine-divergence.md section 13:
 * $4D's `effFrame` shift and mask, $4E's `attrOverride` shift and masks, and
 * $2C's `initTableByX` operand, which lives in the INIT handler and has no
 * handler-relative `CodeRef` form.
 */
describe.skipIf(!romsPresent)('the bespoke descriptors read their own bytes', () => {
  const D = (id: number) => SPRITE_DRAW_DESCRIPTORS.find(x => x.spriteId === id)!
  const SPINY = D(0x14),
    MOLE = D(0x4d),
    LEDGE_MOLE = D(0x4e)
  const at = (rom: RomFile, d: SpriteDrawDescriptor, ref: CodeRef) =>
    refAt(rom, ref, resolveHandlerBase(rom, d))
  const pose = (rom: RomFile, d: SpriteDrawDescriptor, f = 0) =>
    parts(rom, f, d)
      .map(p => `${p.charNum}${p.flipX ? 'X' : ''}${p.flipY ? 'Y' : ''}@${p.dx},${p.dy}`)
      .join('|')

  it.each(CORPUS)('%s: all three draw JSRs resolve to the traced routine', name => {
    const rom = freshRom(name)
    const routineAt = (d: SpriteDrawDescriptor) => {
      const b = rom.readAt(at(rom, d, d.routineJsr!), 3)!
      expect(b[0]).toBe(0x20)
      return SHARED_DRAW_ROUTINES.find(r => r.addr === (b[1] | (b[2] << 8)))?.routine
    }
    expect(routineAt(SPINY)).toBe('sub0')
    expect(routineAt(MOLE)).toBe('sub0')
    expect(routineAt(LEDGE_MOLE)).toBe('sub2')
  })

  it.each([0x14, 0x4d, 0x4e])('$%s: NOPping the draw JSR is refused', id => {
    const rom = freshRom()
    const d = D(id as number)
    rom.writeAt(at(rom, d, d.routineJsr!), [0xea])
    const res = draw(rom, 0, d)
    expect(res.ok).toBe(false)
    expect(res.ok === false && res.failure.kind).toBe('unexpectedOpcode')
  })

  it('repointing $14 at SubSprGfx2Entry1 changes what it draws', () => {
    // sub0 reads four INDEPENDENT tiles; sub2 expands ONE into four corners.
    // Both emit four subtiles, so the count cannot tell them apart and the
    // pose has to.
    const rom = freshRom()
    const before = pose(rom, SPINY)
    const sub2 = SHARED_DRAW_ROUTINES.find(r => r.routine === 'sub2')!.addr
    rom.writeAt(at(rom, SPINY, SPINY.routineJsr!) + 1, [sub2 & 0xff, sub2 >> 8])
    expect(pose(rom, SPINY)).not.toBe(before)
  })

  it('$14 takes its prop group from the LDA #$02 immediate', () => {
    const rom = freshRom()
    expect(rom.readAt(at(rom, SPINY, { mainOff: 0x2f }), 2)![1]).toBe(0x02)
    const before = pose(rom, SPINY)
    // Prop group selects four GeneralSprGfxProp bytes, which carry the
    // per-corner flips (bank_01.asm:3853).
    rom.writeAt(at(rom, SPINY, { mainOff: 0x2f }) + 1, [0x01])
    expect(pose(rom, SPINY)).not.toBe(before)
  })

  it('$14 with its LDA replaced is refused, not read as a raw byte', () => {
    const rom = freshRom()
    rom.writeAt(at(rom, SPINY, { mainOff: 0x2f }), [0xea])
    expect(draw(rom, 0, SPINY).ok).toBe(false)
  })

  it('$14 counts its animation shift out of SetAnimationFrame', () => {
    const rom = freshRom()
    const sc = (SPINY.anim as { shiftAt: Parameters<typeof readShiftCount>[1] }).shiftAt
    const base = resolveHandlerBase(rom, SPINY)
    expect(readShiftCount(rom, sc, base)).toBe(3)
    // The shared routine is reached by hopping through $14's OWN `JSR`
    // (bank_01.asm:1799), so a planted fourth `LSR A` must move it.
    rom.writeAt(refAt(rom, sc.scan, base) + 3, [0x4a])
    expect(readShiftCount(rom, sc, base)).toBe(4)
  })

  it('$4D resolves BOTH table addresses from their LDA operands', () => {
    const rom = freshRom()
    const tileOp = at(rom, MOLE, { mainOff: 0x84 })
    const propOp = at(rom, MOLE, { mainOff: 0x8a })
    const word = (a: number) => {
      const b = rom.readAt(a, 2)!
      return b[0] | (b[1] << 8)
    }
    // The two tables are two bytes apart (bank_01.asm:13406-13410).
    expect(word(propOp) - word(tileOp)).toBe(2)

    const before = pose(rom, MOLE)
    // Point the tile-group read at the PROP table, which holds different
    // bytes, and the drawn quad must move.
    rom.writeAt(tileOp, [word(propOp) & 0xff, word(propOp) >> 8])
    expect(pose(rom, MOLE)).not.toBe(before)
  })

  it('$4D follows a relocated prop-group table', () => {
    const rom = freshRom()
    const propOp = at(rom, MOLE, { mainOff: 0x8a })
    const before = pose(rom, MOLE)
    // Copy the table somewhere else, change it, and repoint the operand.
    const moved = 0xe900
    rom.writeAt(0x010000 | moved, [0x03, 0x03])
    rom.writeAt(propOp, [moved & 0xff, moved >> 8])
    expect(pose(rom, MOLE)).not.toBe(before)
  })

  it('$4E takes its tile group from the LDA #$03 immediate', () => {
    const rom = freshRom()
    expect(rom.readAt(at(rom, LEDGE_MOLE, { mainOff: 0x9f }), 2)![1]).toBe(0x03)
    const before = pose(rom, LEDGE_MOLE)
    rom.writeAt(at(rom, LEDGE_MOLE, { mainOff: 0x9f }) + 1, [0x01])
    expect(pose(rom, LEDGE_MOLE)).not.toBe(before)
  })

  it('$4D and $4E share a handler and still read different offsets', () => {
    // They resolve the same MAIN pointer (bank_01.asm:13388), so a plant in
    // ONE branch must not move the other. That is the specific risk of two
    // descriptors sharing `vanillaMainHandler`.
    const rom = freshRom()
    expect(resolveHandlerBase(rom, MOLE)).toBe(resolveHandlerBase(rom, LEDGE_MOLE))
    const moleBefore = pose(rom, MOLE)
    rom.writeAt(at(rom, LEDGE_MOLE, { mainOff: 0x9f }) + 1, [0x01])
    expect(pose(rom, MOLE)).toBe(moleBefore)
  })
})
