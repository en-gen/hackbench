/**
 * The `Spr0to13Gfx` walk family, and every value it reads out of the cart.
 *
 * $00-$03 shell-less Koopas and $04-$07/$0F/$11/$13 reach ONE draw routine
 * (bank_01.asm:1748) from two different MAIN handlers, and that routine
 * decides per sprite ID whether to draw a 16x16 or a 16x32, out of a ROM
 * table bit. Four things are therefore read rather than held:
 *
 *   the animation shift and mask  runs of `LSR A` and an `AND` immediate
 *                                 inside `SetAnimationFrame`, located by
 *                                 hopping through the handler's own `JSR`
 *   the property table's address  operand of `LDA Spr0to13Prop,Y`
 *   the selecting bit             operand of the `AND #$40`
 *   each branch's routine         its own `JSR` target
 *   the 1 px walk bob             `SBC` operand plus the carry the preceding
 *                                 `LSR A` run leaves in the tile group
 *
 * Every test below plants a DIFFERENT byte in an in-memory copy of a real
 * cart and proves the render follows it. A read that no planted byte can
 * disturb is not a read.
 *
 * Nothing is written to disk: `RomFile.writeAt` mutates the loaded buffer,
 * and every test opens its own copy.
 *
 * Evidence scope: planted-byte tests run on
 * `Super Mario World (USA).vanilla.sfc`; the "vanilla holds N" tests run on
 * all six carts in `test/roms/`. Static traces against `C:\Projects\SMWDisX`,
 * line numbers checked by opening `bank_01.asm` at each one. No emulator was
 * run, so nothing here is verified against live hardware.
 */

import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve } from 'path'
import { RomFile } from '../../../../src/rom/RomFile'
import { readSpriteTileTables } from '../../../../src/rom/SpriteTileLoader'
import {
  SPRITE_DRAW_DESCRIPTORS, SPRITE_MAIN_PTR_TABLE,
  type CodeRef, type SpriteDrawDescriptor,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawDescriptor'
import {
  animPeriodFrames, drawSpriteParts, frameIndexAt, readShiftCount,
  resolveAnim, resolveHandlerBase, resolveRef,
  type EnginePart, type EngineResult,
} from '../../../../src/rom/model/sprites/generic/SpriteDrawEngine'

const ROM_DIR = resolve(__dirname, '../../../roms')
const ROM_FILES = [
  'Super Mario World (USA).vanilla.sfc',
  'Super Mario World (USA).magic.sfc',
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
] as const
const romsPresent = ROM_FILES.every(f => existsSync(resolve(ROM_DIR, f)))

const freshRom = (name: (typeof ROM_FILES)[number] = ROM_FILES[0]) =>
  RomFile.load(resolve(ROM_DIR, name))

const desc = (id: number): SpriteDrawDescriptor =>
  SPRITE_DRAW_DESCRIPTORS.find(d => d.spriteId === id)!

/** $00 Green Koopa with no shell, the sprite the user reported as static. */
const SHELLESS = 0x00
/** $04 Green Koopa, the same family's 16x32 branch. */
const SHELLED = 0x04
/** $0F Goomba, a 16x16 on the `Spr0to13Start` handler. */
const GOOMBA = 0x0F

/** `resolveRef` that throws rather than returning null, so a planted byte is
 *  never written to address 0 because a ref quietly failed. */
function refAt(rom: RomFile, ref: CodeRef, base: number): number {
  const at = resolveRef(rom, ref, base)
  if (at === null) throw new Error('CodeRef did not resolve')
  return at
}

/** Address of one of `routineSelect`'s refs on this cart. */
function selAt(rom: RomFile, id: number, pick: (s: NonNullable<SpriteDrawDescriptor['routineSelect']>) => CodeRef): number {
  const d = desc(id)
  return refAt(rom, pick(d.routineSelect!), resolveHandlerBase(rom, d))
}

function draw(rom: RomFile, id: number, frame: number): EngineResult {
  return drawSpriteParts({
    rom, tables: readSpriteTileTables(rom)!, descriptor: desc(id),
    // Mario to the RIGHT of the sprite, which is latch 0 on `FaceMario`.
    spriteX: 0x40, ctx: { marioX: 0x80, romFrame: 0 }, forceFrame: frame,
  })
}

function parts(rom: RomFile, id: number, frame: number): EnginePart[] {
  const r = draw(rom, id, frame)
  if (!r.ok) throw new Error(`$${id.toString(16)} frame ${frame}: ${JSON.stringify(r.failure)}`)
  return r.parts
}

const poseKey = (p: readonly EnginePart[]) =>
  p.map(q => `${q.charNum.toString(16)}@${q.dx},${q.dy}`).join('|')

/** Topmost 8 px row the sprite occupies. The bob is the only thing that
 *  moves it within one routine branch. */
const topDy = (p: readonly EnginePart[]) => Math.min(...p.map(q => q.dy))

// ── 1. The two handlers both reach the shared draw routine ──────────────────

describe.skipIf(!romsPresent)('the walk family renders at all', () => {
  const FAMILY = [0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x0F, 0x11, 0x13]

  it.each(ROM_FILES)('%s: every member draws two DISTINCT frames', name => {
    const rom = freshRom(name)
    for (const id of FAMILY) {
      const a = poseKey(parts(rom, id, 0))
      const b = poseKey(parts(rom, id, 1))
      expect(a, `$${id.toString(16)} frame 0 must draw`).not.toBe('')
      expect(b, `$${id.toString(16)} walk frames must differ`).not.toBe(a)
    }
  })

  it.each(ROM_FILES)('%s: $00-$03 draw one 16x16 and $04-$07 two stacked', name => {
    const rom = freshRom(name)
    for (const id of [0x00, 0x01, 0x02, 0x03, 0x0F, 0x11, 0x13]) {
      expect(parts(rom, id, 0), `$${id.toString(16)}`).toHaveLength(4)
    }
    for (const id of [0x04, 0x05, 0x06, 0x07]) {
      expect(parts(rom, id, 0), `$${id.toString(16)}`).toHaveLength(8)
    }
  })

  it('$0C is deliberately absent, because its draw ends in KoopaWingGfxRt', () => {
    // bank_01.asm:1785-1788. If someone adds $0C without a wing kind, this
    // goes red and says why rather than shipping a wingless Koopa.
    expect(SPRITE_DRAW_DESCRIPTORS.some(d => d.spriteId === 0x0C)).toBe(false)
  })
})

// ── 2. The animation shift and mask, read out of SetAnimationFrame ──────────

describe.skipIf(!romsPresent)('SetAnimationFrame is read, not recorded', () => {
  const animOf = (rom: RomFile, id: number) =>
    resolveAnim(rom, desc(id).anim, resolveHandlerBase(rom, desc(id)))!

  it.each(ROM_FILES)('%s: the shift is a run of three LSR A', name => {
    const rom = freshRom(name)
    for (const id of [SHELLESS, SHELLED]) {
      const sc = (desc(id).anim as { shiftAt: Parameters<typeof readShiftCount>[1] }).shiftAt
      expect(readShiftCount(rom, sc, resolveHandlerBase(rom, desc(id))), `$${id.toString(16)}`).toBe(3)
    }
  })

  it.each(ROM_FILES)('%s: both handlers resolve the SAME shift and mask', name => {
    // $00 hops through its own carried-pose `JSR` (bank_01.asm:1407) and $04
    // through the walk path's (bank_01.asm:1691). Different anchors, one
    // routine, so they must agree.
    const rom = freshRom(name)
    expect(animOf(rom, SHELLESS)).toEqual(animOf(rom, SHELLED))
    expect(animOf(rom, SHELLESS)).toEqual({ kind: 'spriteCounter', shift: 3, mask: 1 })
  })

  it('a planted fourth LSR A halves the walk speed', () => {
    const rom = freshRom()
    const before = animPeriodFrames(animOf(rom, SHELLESS))
    const sc = (desc(SHELLESS).anim as { shiftAt: Parameters<typeof readShiftCount>[1] }).shiftAt
    // Overwrite the `AND #$01` opcode with a fourth `LSR A`. The mask operand
    // byte $01 then reads as `ORA ($xx,X)`'s opcode, which the mask ref does
    // not care about: it reads the byte one further along.
    rom.writeAt(refAt(rom, sc.scan, resolveHandlerBase(rom, desc(SHELLESS))) + 3, [0x4A])
    expect(animPeriodFrames(animOf(rom, SHELLESS))).toBe(before * 2)
    // Vanilla flips at game frame 8; a fourth shift moves that to 16.
    expect(frameIndexAt(animOf(rom, SHELLESS), 8)).toBe(0)
    expect(frameIndexAt(animOf(rom, SHELLESS), 16)).toBe(1)
  })

  it('a planted wider AND mask gives the walk four frames', () => {
    const rom = freshRom()
    const maskAt = (desc(SHELLESS).anim as { maskAt: CodeRef }).maskAt
    rom.writeAt(refAt(rom, maskAt, resolveHandlerBase(rom, desc(SHELLESS))), [0x03])
    const anim = animOf(rom, SHELLESS)
    expect(anim).toEqual({ kind: 'spriteCounter', shift: 3, mask: 3 })
    expect(animPeriodFrames(anim)).toBe(32)
  })

  it('a planted non-JSR at the anchor makes the animation unresolvable', () => {
    // $00's anchor is the `JSR SetAnimationFrame` at bank_01.asm:1407. A hack
    // that replaces it has rewritten the handler, and the engine must decline
    // rather than read a shift out of whatever follows.
    const rom = freshRom()
    const d = desc(SHELLESS)
    rom.writeAt(resolveHandlerBase(rom, d) + 0x0F, [0xEA])   // NOP
    expect(resolveAnim(rom, d.anim, resolveHandlerBase(rom, d))).toBeNull()
    expect(draw(rom, SHELLESS, 0).ok).toBe(false)
  })
})

// ── 3. The routine choice, read out of the property table and the JSRs ──────

describe.skipIf(!romsPresent)('the 16x16 / 16x32 choice is read per cart', () => {
  it.each(ROM_FILES)('%s: the property table operand resolves to $01:88F0', name => {
    const rom = freshRom(name)
    const operand = selAt(rom, SHELLESS, s => s.propOperandAddr)
    const b = rom.readAt(operand, 2)!
    expect(b[0] | (b[1] << 8)).toBe(0x88F0)
  })

  it.each(ROM_FILES)('%s: the selecting bit is $40', name => {
    const rom = freshRom(name)
    expect(rom.readAt(selAt(rom, SHELLESS, s => s.maskOperandAddr), 1)![0]).toBe(0x40)
  })

  it('setting the property bit on a shell-less Koopa draws it 16x32', () => {
    // The table byte, not the descriptor, decides. A hack that retunes
    // Spr0to13Prop gets the taller sprite.
    //
    // $00 and NOT $0F: the 16x32 branch falls through to the wing call at
    // bank_01.asm:1785-1788, which fires for every sprite number at or above
    // its `CMP #$08`. $00 is below that threshold, so this isolates the
    // routine choice from the wing tail. Section 6 covers the other half.
    const rom = freshRom()
    expect(parts(rom, SHELLESS, 0)).toHaveLength(4)
    rom.writeAt(0x0188F0 + SHELLESS, [0x60])     // $20 | $40
    expect(parts(rom, SHELLESS, 0)).toHaveLength(8)
  })

  it('clearing the property bit on a Koopa draws it 16x16', () => {
    const rom = freshRom()
    expect(parts(rom, SHELLED, 0)).toHaveLength(8)
    rom.writeAt(0x0188F0 + SHELLED, [0x00])
    expect(parts(rom, SHELLED, 0)).toHaveLength(4)
  })

  it('a planted AND #$00 sends every member down the clear branch', () => {
    const rom = freshRom()
    rom.writeAt(selAt(rom, SHELLED, s => s.maskOperandAddr), [0x00])
    expect(parts(rom, SHELLED, 0)).toHaveLength(4)
  })

  it('repointing the table operand moves which bytes are consulted', () => {
    const rom = freshRom()
    // Point `LDA Spr0to13Prop,Y` at a stretch whose $04th byte has bit 6
    // clear. $88EC is `Spr0to13SpeedX` (bank_01.asm:1389), four bytes of
    // speed, so entry $04 falls on `Spr0to13Prop`'s own entry $00 = $00.
    rom.writeAt(selAt(rom, SHELLED, s => s.propOperandAddr), [0xEC, 0x88])
    expect(parts(rom, SHELLED, 0)).toHaveLength(4)
  })

  it('swapping the two branch JSRs swaps the two shapes', () => {
    const rom = freshRom()
    const clear = selAt(rom, SHELLED, s => s.jsrIfClear)
    const set = selAt(rom, SHELLED, s => s.jsrIfSet)
    // Snapshot both before either write: `readAt` hands back a view onto the
    // loaded buffer, so holding one across a write would read the new bytes.
    const a = Array.from(rom.readAt(clear, 3)!)
    const b = Array.from(rom.readAt(set, 3)!)
    rom.writeAt(clear, b)
    rom.writeAt(set, a)
    expect(parts(rom, SHELLED, 0)).toHaveLength(4)     // set branch now 16x16
    expect(parts(rom, SHELLESS, 0)).toHaveLength(8)    // clear branch now 16x32
  })

  it('a branch JSR into untraced code is reported, not guessed', () => {
    const rom = freshRom()
    const at = selAt(rom, SHELLESS, s => s.jsrIfClear)
    rom.writeAt(at + 1, [0x00, 0x90])
    const res = draw(rom, SHELLESS, 0)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.failure.kind).toBe('unknownDrawRoutine')
  })

  it('a branch site that is no longer a JSR is reported as such', () => {
    const rom = freshRom()
    rom.writeAt(selAt(rom, SHELLESS, s => s.jsrIfClear), [0xEA])
    const res = draw(rom, SHELLESS, 0)
    expect(res.ok).toBe(false)
    if (res.ok) throw new Error('unreachable')
    expect(res.failure.kind).toBe('unexpectedOpcode')
  })
})

// ── 4. The 1 px walk bob on the 16x32 branch ────────────────────────────────

describe.skipIf(!romsPresent)('the bob is the SBC operand plus a carry', () => {
  it.each(ROM_FILES)('%s: vanilla holds SBC #$0F and a single LSR A', name => {
    const rom = freshRom(name)
    expect(rom.readAt(selAt(rom, SHELLED, s => s.setBranchYAdjust!.sbcOperandAddr), 1)![0]).toBe(0x0F)
    const d = desc(SHELLED)
    expect(readShiftCount(rom, d.routineSelect!.setBranchYAdjust!.carryShift, resolveHandlerBase(rom, d))).toBe(1)
  })

  it.each(ROM_FILES)('%s: frame 1 sits exactly one pixel below frame 0', name => {
    const rom = freshRom(name)
    expect(topDy(parts(rom, SHELLED, 1)) - topDy(parts(rom, SHELLED, 0))).toBe(1)
    // And the 16x16 branch has no adjust at all, because it never runs the
    // `SBC` (bank_01.asm:1766 returns before it).
    expect(topDy(parts(rom, SHELLESS, 1))).toBe(topDy(parts(rom, SHELLESS, 0)))
  })

  it('a planted SBC operand moves the whole body', () => {
    const rom = freshRom()
    const before = topDy(parts(rom, SHELLED, 0))
    rom.writeAt(selAt(rom, SHELLED, s => s.setBranchYAdjust!.sbcOperandAddr), [0x1F])
    expect(topDy(parts(rom, SHELLED, 0))).toBe(before - 0x10)
    // The bob rides on top of it, unchanged.
    expect(topDy(parts(rom, SHELLED, 1)) - topDy(parts(rom, SHELLED, 0))).toBe(1)
  })

  it('removing the LSR A removes the bob', () => {
    // The disassembly annotates that `LSR A` "Nothing?" (bank_01.asm:1770).
    // Its ACCUMULATOR result is indeed dead; its carry is not, and this is
    // the assertion that says so.
    const rom = freshRom()
    rom.writeAt(selAt(rom, SHELLED, s => s.setBranchYAdjust!.carryShift.scan), [0xEA])
    expect(topDy(parts(rom, SHELLED, 1))).toBe(topDy(parts(rom, SHELLED, 0)))
  })

  it.each(ROM_FILES)('%s: both branches sit where the ASM puts them, absolutely', name => {
    // The relative assertions above survive an anchoring error that moves the
    // whole family; these do not. Derived from the trace, not read back:
    //
    //   16x16: `JSR SubSprGfx2Entry1` with NO Y adjust (bank_01.asm:1766).
    //          `_1` goes to `OAMTileYPos+$100` (bank_01.asm:4165), so the one
    //          large OBJ's corners sit at 0, 0, 8, 8.
    //   16x32: `SBC #$0F` on `SpriteYPosLow` BEFORE the `JSR`
    //          (bank_01.asm:1774) moves the body up by `$0F + 1 - carry`.
    //          Frame 0's tile group is 0, so the carry is clear and the shift
    //          is 16. `SubSprGfx1` then puts the top entry at that Y and the
    //          bottom `+$10` below it (bank_01.asm:3948-3952).
    const rom = freshRom(name)
    expect(parts(rom, SHELLESS, 0).map(p => p.dy)).toEqual([0, 0, 8, 8])
    expect(parts(rom, SHELLED, 0).map(p => p.dy))
      .toEqual([-16, -16, -8, -8, 0, 0, 8, 8])
    // Frame 1's tile group is 1, so the carry is set and the shift is 15.
    expect(parts(rom, SHELLED, 1).map(p => p.dy))
      .toEqual([-15, -15, -7, -7, 1, 1, 9, 9])
  })

  it('a planted second LSR A takes the carry from the next bit up', () => {
    const rom = freshRom()
    const at = selAt(rom, SHELLED, s => s.setBranchYAdjust!.carryShift.scan)
    const d = desc(SHELLED)
    rom.writeAt(at + 1, [0x4A])
    expect(readShiftCount(rom, d.routineSelect!.setBranchYAdjust!.carryShift, resolveHandlerBase(rom, d))).toBe(2)
    // Bit 1 of a two-frame walk's tile group is always 0, so the bob stops.
    expect(topDy(parts(rom, SHELLED, 1))).toBe(topDy(parts(rom, SHELLED, 0)))
    // A tile group of 2 or 3 would bob, and forcing frame 3 shows it does.
    expect(topDy(parts(rom, SHELLED, 3))).toBe(topDy(parts(rom, SHELLED, 0)) + 1)
  })
})

// ── 5. Anchoring: the linked CodeRef follows a relocated handler ────────────

describe.skipIf(!romsPresent)('every ref is anchored past the cart pointer', () => {
  /** Copy `len` bytes of `ShellessKoopas` to `to` and repoint entry $00. */
  function relocate(rom: RomFile, id: number, to: number, len = 0x40): void {
    const from = resolveHandlerBase(rom, desc(id))
    rom.writeAt(0x010000 | to, Array.from(rom.readAt(from, len)!))
    rom.writeAt(SPRITE_MAIN_PTR_TABLE + id * 2, [to & 0xFF, (to >> 8) & 0xFF])
  }

  it('a relocated ShellessKoopas still renders identically', () => {
    const rom = freshRom()
    const before = poseKey(parts(rom, SHELLESS, 1))
    // $01:E800 is inside `Return01F87B`'s bank and unused by any descriptor.
    relocate(rom, SHELLESS, 0xE800)
    expect(poseKey(parts(rom, SHELLESS, 1))).toBe(before)
  })

  it('after relocation the OLD location is no longer read', () => {
    const rom = freshRom()
    const original = resolveHandlerBase(rom, desc(SHELLESS)) & 0xFFFF
    relocate(rom, SHELLESS, 0xE800)
    const before = poseKey(parts(rom, SHELLESS, 1))
    // Wreck the `JSR SetAnimationFrame` at the ABANDONED address. If the
    // engine still anchored there, the animation would stop resolving.
    rom.writeAt(0x010000 | (original + 0x0F), [0xEA])
    expect(poseKey(parts(rom, SHELLESS, 1))).toBe(before)
  })

  it('the JMP hop is followed, not assumed', () => {
    const rom = freshRom()
    const base = resolveHandlerBase(rom, desc(SHELLESS))
    const hop = rom.readAt(base + 0x2A, 3)!
    expect(hop[0]).toBe(0x4C)                     // JMP abs, bank_01.asm:1418
    const target = hop[1] | (hop[2] << 8)
    // Move the three bytes the hop lands three past, then repoint the JMP.
    const moved = 0xE900
    rom.writeAt(0x010000 | moved, Array.from(rom.readAt(0x010000 | (target + 3), 3)!))
    const before = poseKey(parts(rom, SHELLESS, 1))
    rom.writeAt(base + 0x2A + 1, [(moved - 3) & 0xFF, ((moved - 3) >> 8) & 0xFF])
    expect(poseKey(parts(rom, SHELLESS, 1))).toBe(before)
    // And the original site is now irrelevant.
    rom.writeAt(0x010000 | (target + 3), [0xEA])
    expect(poseKey(parts(rom, SHELLESS, 1))).toBe(before)
  })

  it.each(ROM_FILES)('%s: the stepped-over instruction really is a 3-byte JSR', name => {
    // `shellessKoopa`'s `gfxJsr` is `{ via: { mainOff: $2A }, off: 3 }`, and
    // that 3 is an instruction LENGTH, not a position: it clears the
    // `JSR SubSprSprInteract` at `CODE_018B03` (bank_01.asm:1655) to reach
    // the `JSR Spr0to13Gfx` after it (bank_01.asm:1656). Nothing targets the
    // second `JSR`, so no named hop lands on it. This pins the assumption.
    const rom = freshRom(name)
    const base = resolveHandlerBase(rom, desc(SHELLESS))
    const jmp = rom.readAt(base + 0x2A, 3)!
    expect(jmp[0]).toBe(0x4C)                                  // JMP abs
    const target = 0x010000 | (jmp[1] | (jmp[2] << 8))
    expect(rom.readAt(target, 1)![0]).toBe(0x20)               // JSR SubSprSprInteract
    expect(rom.readAt(target + 3, 1)![0]).toBe(0x20)           // JSR Spr0to13Gfx
  })

  it('a hop through something that is not a JSR or JMP does not resolve', () => {
    const rom = freshRom()
    const base = resolveHandlerBase(rom, desc(SHELLESS))
    rom.writeAt(base + 0x2A, [0xEA])
    expect(resolveRef(rom, desc(SHELLESS).routineSelect!.maskOperandAddr, base)).toBeNull()
    expect(draw(rom, SHELLESS, 0).ok).toBe(false)
  })
})

// ── 6. The wing tail, read out of its CMP and its JSR ───────────────────────

/**
 * `Spr0to13Gfx` ends the 16x32 branch with `LDA SpriteNumber,X : CMP #$08 :
 * BCC + : JSR KoopaWingGfxRt` (bank_01.asm:1785-1788). Wings therefore need
 * BOTH the property bit AND a sprite number at or above the immediate, and
 * the property bit is a per-cart value. A static exclusion list keyed on
 * $0C would render a winged Goomba as a clean wingless body on any cart that
 * sets $0F's bit, which is the wrong-but-confident outcome the engine exists
 * to refuse.
 *
 * Both gate bytes are planted below and the render is required to follow
 * them in both directions.
 */
describe.skipIf(!romsPresent)('the wing tail is read, not assumed', () => {
  const tailAt = (rom: RomFile, id: number, pick: (t: NonNullable<NonNullable<SpriteDrawDescriptor['routineSelect']>['setBranchTailCall']>) => CodeRef) => {
    const d = desc(id)
    return refAt(rom, pick(d.routineSelect!.setBranchTailCall!), resolveHandlerBase(rom, d))
  }

  it.each(ROM_FILES)('%s: the threshold is $08 and the gated call is a JSR', name => {
    const rom = freshRom(name)
    expect(rom.readAt(tailAt(rom, GOOMBA, t => t.cmpOperandAddr), 1)![0]).toBe(0x08)
    expect(rom.readAt(tailAt(rom, GOOMBA, t => t.jsrAddr), 1)![0]).toBe(0x20)
  })

  it('a Goomba given the property bit is DECLINED, not drawn wingless', () => {
    // The defect this section exists for. $0F clears the `CMP #$08`, so the
    // ROM draws body PLUS wings; the engine has no kind for the wings and
    // must say so rather than emit the eight clean subtiles of the body.
    const rom = freshRom()
    expect(parts(rom, GOOMBA, 0)).toHaveLength(4)     // vanilla: 16x16, no wings
    rom.writeAt(0x0188F0 + GOOMBA, [0x60])            // $20 | $40
    const r = draw(rom, GOOMBA, 0)
    expect(r.ok).toBe(false)
    if (r.ok) throw new Error('unreachable')
    expect(r.failure).toEqual({
      kind: 'unmodelledTailCall', spriteId: GOOMBA,
      routineName: 'KoopaWingGfxRt',
      addr: tailAt(rom, GOOMBA, t => t.jsrAddr),
    })
  })

  it('$11 and $13 are declined on the same gate, $00-$07 are not', () => {
    // The threshold is a number, not a list: everything at or above it is
    // affected, and nothing below it is.
    const rom = freshRom()
    for (const id of [0x11, 0x13]) {
      rom.writeAt(0x0188F0 + id, [0x60])
      expect(draw(rom, id, 0).ok, `$${id.toString(16)} must decline`).toBe(false)
    }
    for (const id of [0x00, 0x04]) {
      rom.writeAt(0x0188F0 + id, [0x60])
      expect(parts(rom, id, 0), `$${id.toString(16)} must still render`).toHaveLength(8)
    }
  })

  it('lowering the CMP immediate to #$00 declines $04-$07 too', () => {
    // A hack that widens the gate wings the shelled Koopas, which already
    // take the 16x32 branch on a vanilla cart. The engine must follow the
    // byte rather than the vanilla threshold.
    const rom = freshRom()
    expect(parts(rom, SHELLED, 0)).toHaveLength(8)
    rom.writeAt(tailAt(rom, SHELLED, t => t.cmpOperandAddr), [0x00])
    expect(draw(rom, SHELLED, 0).ok).toBe(false)
  })

  it('raising the CMP immediate past $13 renders a winged Goomba clean', () => {
    // The other direction, which a one-way check would miss: a hack that
    // narrows the gate has REMOVED the wings, and the body is then the whole
    // sprite and safe to draw.
    const rom = freshRom()
    rom.writeAt(0x0188F0 + GOOMBA, [0x60])
    expect(draw(rom, GOOMBA, 0).ok).toBe(false)
    rom.writeAt(tailAt(rom, GOOMBA, t => t.cmpOperandAddr), [0x40])
    expect(parts(rom, GOOMBA, 0)).toHaveLength(8)
  })

  it('NOPping the wing JSR out renders a winged Goomba clean', () => {
    // The call itself is read, not just its threshold. Removing it removes
    // the reason to decline.
    const rom = freshRom()
    rom.writeAt(0x0188F0 + GOOMBA, [0x60])
    expect(draw(rom, GOOMBA, 0).ok).toBe(false)
    rom.writeAt(tailAt(rom, GOOMBA, t => t.jsrAddr), [0xEA])
    expect(parts(rom, GOOMBA, 0)).toHaveLength(8)
  })

  it('the clear branch never reaches the tail, whatever the threshold says', () => {
    // `BRA +` at bank_01.asm:1767 jumps past the wing call, so a 16x16
    // Goomba is unaffected by the gate even at #$00.
    const rom = freshRom()
    rom.writeAt(tailAt(rom, GOOMBA, t => t.cmpOperandAddr), [0x00])
    expect(parts(rom, GOOMBA, 0)).toHaveLength(4)
  })
})
