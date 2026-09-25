/**
 * The sprite-pointer and VerticalTable reads CODE_05D8B7 (bank_05.asm:7248-
 * 7258) and CODE_0584E3 (bank_05.asm:552) perform, plus the Lunar Magic hook
 * shapes recognized alongside the vanilla bytes. Every ROM here is built in
 * the test, so both gates are proven where CI runs: with no corpus.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  readSpritePointerSite,
  readVerticalTable,
  VERTICAL_TABLE_LENGTH,
} from '../../../src/rom/LevelTableGate'

// No bytes here come from any Super Mario World ROM: every instruction is
// written from the 65816 encoding. Placed at an arbitrary LoROM address;
// findPattern locates the lead-in by shape, not position.
const b16 = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff]
const b24 = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, (a >> 16) & 0xff]

const LEAD_AT = 0x05d000
const INDEX_VANILLA = [0xa5, 0x0e, 0x0a, 0xa8]
const MID_VANILLA = [0xa9, 0x00, 0x00, 0xe2, 0x20]
const leadIn = (tableAddr: number): number[] => [
  0xb9,
  ...b16(tableAddr),
  0x85,
  0xce,
  0xb9,
  ...b16(tableAddr + 1),
  0x85,
  0xcf,
]
const tailFixed = (bank: number): number[] => [0xa9, bank, 0x85, 0xd0]
const tailJsl = (target: number): number[] => [0x22, ...b24(target)]

/** A full vanilla-shaped sprite read: index, mid, lead-in and tail, at `at`. */
function plantSpriteSite(
  rom: RomFile,
  at: number,
  tableAddr: number,
  tail: number[] = tailFixed(0x09),
  index = INDEX_VANILLA,
  mid = MID_VANILLA,
): void {
  rom.writeAt(at - 9, index)
  rom.writeAt(at - 5, mid)
  rom.writeAt(at, leadIn(tableAddr))
  rom.writeAt(at + 10, tail)
}

// Lunar Magic's per-level index routine (recognized alongside the vanilla
// LDA/ASL/TAY at bank_05.asm:7248-7250).
const INDEX_ROUTINE = [0xa5, 0x0e, 0x1a, 0x85, 0xfe, 0x3a, 0x0a, 0xa8, 0x6b]
const INDEX_ROUTINE_SEVEN = [0xa5, 0x0e, 0x8d, 0x0b, 0x01, 0x1a, 0x85, 0xfe, 0x3a, 0x0a, 0xa8, 0x6b]

// Lunar Magic's per-level sprite-bank routine (recognized alongside the
// vanilla `LDA #imm` at bank_05.asm:7257).
const bankRoutine = (tableAddr: number): number[] => [
  0x8b,
  0x4b,
  0xab,
  0xa4,
  0x0e,
  0xb9,
  ...b16(tableAddr),
  0x85,
  0xd0,
  0xab,
  0x6b,
]

function makeRom(size = 0x200000): RomFile {
  const buf = Buffer.alloc(size, 0x00)
  buf[0x7fd5] = 0x20 // LoROM
  return new RomFile('synthetic.smc', buf)
}

describe('readSpritePointerSite', () => {
  it('reads the table address and bank from CODE_05D8B7 own operands', () => {
    const rom = makeRom()
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07))
    expect(readSpritePointerSite(rom)).toEqual({
      ok: true,
      tableAddr: 0x05ec00,
      bank: { kind: 'fixed', bank: 0x07 },
    })
  })

  it('follows a table relocated by a hack', () => {
    const rom = makeRom()
    plantSpriteSite(rom, LEAD_AT, 0x9100, tailFixed(0x09))
    expect(readSpritePointerSite(rom)).toEqual({
      ok: true,
      tableAddr: 0x059100,
      bank: { kind: 'fixed', bank: 0x09 },
    })
  })

  it('takes the bank from the lead-in own address, not a hardcoded $05', () => {
    const rom = makeRom()
    const at = 0x09d000 // bank $09, not $05
    plantSpriteSite(rom, at, 0x9100, tailFixed(0x09))
    expect(readSpritePointerSite(rom)).toEqual({
      ok: true,
      tableAddr: 0x099100,
      bank: { kind: 'fixed', bank: 0x09 },
    })
  })

  it('reads a per-level bank from the recognized Lunar Magic routine', () => {
    const rom = makeRom()
    const routineAt = 0x0ef300
    rom.writeAt(routineAt, bankRoutine(0xf100))
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailJsl(routineAt))
    expect(readSpritePointerSite(rom)).toEqual({
      ok: true,
      tableAddr: 0x05ec00,
      bank: { kind: 'perLevel', tableAddr: 0x0ef100 },
    })
  })

  it('accepts the recognized per-level index routine (both variants)', () => {
    for (const routine of [INDEX_ROUTINE, INDEX_ROUTINE_SEVEN]) {
      const rom = makeRom()
      const routineAt = 0x0ef550
      rom.writeAt(routineAt, routine)
      plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07), tailJsl(routineAt))
      expect(readSpritePointerSite(rom).ok).toBe(true)
    }
  })

  it('refuses when the mid setup is diverted through an unrecognized detour', () => {
    const rom = makeRom()
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07))
    rom.writeAt(LEAD_AT - 5, [0x5c, ...b24(0x123456)]) // JML over the mid window
    const site = readSpritePointerSite(rom)
    expect(site).toEqual({ ok: false, reason: expect.stringMatching(/branches on RAM state/) })
  })

  it('refuses when the index is neither vanilla nor a recognized routine', () => {
    const rom = makeRom()
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07))
    rom.writeAt(LEAD_AT - 9, [0xea, 0xea, 0xea, 0xea]) // four NOPs
    const site = readSpritePointerSite(rom)
    expect(site).toEqual({ ok: false, reason: expect.stringMatching(/level index/) })
  })

  it('refuses when the JSL index target does not match a recognized routine body', () => {
    const rom = makeRom()
    const routineAt = 0x0ef550
    rom.writeAt(routineAt, [0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0xea, 0x6b]) // NOPs, not the routine
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07), tailJsl(routineAt))
    expect(readSpritePointerSite(rom).ok).toBe(false)
  })

  it('refuses when the tail is neither vanilla nor a recognized routine', () => {
    const rom = makeRom()
    plantSpriteSite(rom, LEAD_AT, 0xec00, [0xea, 0xea, 0xea, 0xea])
    const site = readSpritePointerSite(rom)
    expect(site).toEqual({ ok: false, reason: expect.stringMatching(/bank byte/) })
  })

  it('refuses when the JSL tail target does not match the recognized bank routine', () => {
    const rom = makeRom()
    const routineAt = 0x0ef300
    rom.writeAt(routineAt, [0x60]) // a bare RTS, not the routine
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailJsl(routineAt))
    expect(readSpritePointerSite(rom).ok).toBe(false)
  })

  it('refuses when the read is not present, and says why', () => {
    const site = readSpritePointerSite(makeRom())
    expect(site).toEqual({ ok: false, reason: expect.stringMatching(/not present/) })
  })

  it('refuses when the read matches more than once', () => {
    const rom = makeRom()
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07))
    rom.writeAt(0x06d000, leadIn(0xec00))
    const site = readSpritePointerSite(rom)
    expect(site).toEqual({ ok: false, reason: expect.stringMatching(/more than once/) })
  })

  it('refuses when the two LDA.W operands do not address one table', () => {
    const rom = makeRom()
    rom.writeAt(LEAD_AT - 9, INDEX_VANILLA)
    rom.writeAt(LEAD_AT - 5, MID_VANILLA)
    rom.writeAt(LEAD_AT, [0xb9, ...b16(0xec00), 0x85, 0xce, 0xb9, ...b16(0xec05), 0x85, 0xcf])
    rom.writeAt(LEAD_AT + 10, tailFixed(0x07))
    expect(readSpritePointerSite(rom).ok).toBe(false)
  })

  // The `B9` and `A9` opcodes are the gate, not the wildcarded operands next
  // to them: a wrong opcode here must refuse on its own, not merely because
  // some other check (like a bounds read) happens to fail too.
  it('refuses when the lead-in opcode is not LDA.W (B9)', () => {
    const rom = makeRom()
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07))
    rom.writeAt(LEAD_AT, [0xbd, ...b16(0xec00)]) // LDA.W abs,X instead of abs,Y
    expect(readSpritePointerSite(rom).ok).toBe(false)
  })

  it('refuses when the fixed-tail opcode is not LDA.B #imm (A9)', () => {
    const rom = makeRom()
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07))
    rom.writeAt(LEAD_AT + 10, [0xa5, 0x07, 0x85, 0xd0]) // LDA.B dp instead of #imm
    expect(readSpritePointerSite(rom).ok).toBe(false)
  })

  // The `E2 20` operand is the gate, not just its opcode: `E2 30` (SEP #$30)
  // also leaves A 8-bit, but additionally truncates the 16-bit index this
  // code just computed into Y -- a different bug the opcode-only check misses.
  it('refuses when the SEP operand is #$30 instead of #$20', () => {
    const rom = makeRom()
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07))
    rom.writeAt(LEAD_AT - 5, [0xa9, 0x00, 0x00, 0xe2, 0x30])
    expect(readSpritePointerSite(rom).ok).toBe(false)
  })

  it('notices a write to the same RomFile, in either direction', () => {
    const rom = makeRom()
    expect(readSpritePointerSite(rom).ok).toBe(false)
    plantSpriteSite(rom, LEAD_AT, 0xec00, tailFixed(0x07))
    expect(readSpritePointerSite(rom).ok).toBe(true)
  })
})

describe('readVerticalTable', () => {
  const table = Array.from({ length: VERTICAL_TABLE_LENGTH }, (_, i) => i)
  const VT_AT = 0x05c000
  const vtVanilla = (addr: number): number[] => [0xbf, ...b24(addr), 0x85, 0x5b]
  const vtJml = (target: number): number[] => [0x5c, ...b24(target), 0x85, 0x5b]

  /**
   * The full 36-byte detour body: the BPL setup, the not-taken (boss) path
   * and the taken (every non-boss level) path, each reloading `addr` and
   * each returning to `ret`. Non-ROM: every fixed byte is written from the
   * 65816 encoding, and masking makes the recognizer's hash indifferent to
   * `addr`/`ret`, so a synthetic pair here matches the same as any other.
   */
  const vtJmlBody = (addr: number, ret: number, ret2 = ret): number[] => [
    0xbf,
    ...b24(addr), // +0  LDA.L addr,X
    0x10,
    0x10, // +4  BPL +$10 (taken when bit 7 clear)
    0xa9,
    0x01, // +6  LDA #$01            -- not-taken (boss) path
    0x8f,
    0x0b,
    0xb4,
    0x7f, // +8  STA $7FB40B
    0xbf,
    ...b24(addr), // +12 LDA.L addr,X (reload)
    0x29,
    0x7f, // +16 AND #$7F
    0x5c,
    ...b24(ret), // +18 JML ret
    0xa9,
    0x00, // +22 LDA #$00            -- taken (common) path
    0x8f,
    0x0b,
    0xb4,
    0x7f, // +24 STA $7FB40B
    0xbf,
    ...b24(addr), // +28 LDA.L addr,X (reload)
    0x5c,
    ...b24(ret2), // +32 JML ret2
  ]

  /** Where the JML back must land: the site's own STA ScreenMode, mirrored
   *  into the $80+ bank the detour uses to read/return through. */
  const mirroredReturn = (siteAddr: number): number => (siteAddr + 4) | 0x800000

  it('reads VerticalTable from CODE_0584E3 own LDA.L operand', () => {
    const rom = makeRom()
    rom.writeAt(VT_AT, vtVanilla(0x058417))
    rom.writeAt(0x058417, table)
    expect(readVerticalTable(rom)).toEqual({ ok: true, table })
  })

  it('follows a table relocated by a hack', () => {
    const rom = makeRom()
    rom.writeAt(VT_AT, vtVanilla(0x059100))
    rom.writeAt(0x059100, table)
    expect(readVerticalTable(rom)).toEqual({ ok: true, table })
  })

  // Site, table and detour all sit at distinct, non-overlapping addresses:
  // siteAt (the JML itself) at $059100, the table at $059300, the detour
  // body in an unrelated bank at $92CB81.
  const siteAt = 0x059100
  const tableAt = 0x859300
  const detourAt = 0x92cb81
  const ret = mirroredReturn(siteAt)

  it('reads the table through the recognized Grand Poo World 2 JML shape, from a synthetic body', () => {
    const rom = makeRom()
    // Arbitrary, non-vanilla table address and return: masking makes the
    // recognizer's hash indifferent to both, so this needs no ROM bytes.
    rom.writeAt(siteAt, vtJml(detourAt))
    rom.writeAt(detourAt, vtJmlBody(tableAt, ret))
    rom.writeAt(tableAt & 0x7fffff, table)
    expect(readVerticalTable(rom)).toEqual({ ok: true, table })
  })

  it('refuses when the taken path (body+22) is corrupted', () => {
    const rom = makeRom()
    rom.writeAt(siteAt, vtJml(detourAt))
    const body = vtJmlBody(tableAt, ret)
    body[22] = 0xea // was 0xa9 (LDA #$00): corrupt the taken path's own opcode
    rom.writeAt(detourAt, body)
    rom.writeAt(tableAt & 0x7fffff, table)
    expect(readVerticalTable(rom).ok).toBe(false)
  })

  it('refuses when the taken path returns somewhere other than STA ScreenMode', () => {
    const rom = makeRom()
    rom.writeAt(siteAt, vtJml(detourAt))
    // ret2 (the taken path's own return) is well-formed and readable, just
    // not the site's STA ScreenMode -- proves the return is independently
    // recomputed, not merely checked for internal agreement.
    rom.writeAt(detourAt, vtJmlBody(tableAt, ret, mirroredReturn(0x059200)))
    rom.writeAt(tableAt & 0x7fffff, table)
    expect(readVerticalTable(rom).ok).toBe(false)
  })

  it('refuses when the two paths reload different table addresses', () => {
    const rom = makeRom()
    rom.writeAt(siteAt, vtJml(detourAt))
    const body = vtJmlBody(tableAt, ret)
    // Corrupt the THIRD load (taken path, offset 29) to a different, still
    // readable address, leaving the hash's fixed bytes untouched.
    rom.writeAt(detourAt, body)
    rom.writeAt(detourAt + 29, b24(0x859500))
    rom.writeAt(tableAt & 0x7fffff, table)
    rom.writeAt(0x059500, table)
    expect(readVerticalTable(rom).ok).toBe(false)
  })

  it('refuses a wrong-shape body even where every operand is otherwise valid and readable', () => {
    const rom = makeRom()
    rom.writeAt(siteAt, vtJml(detourAt))
    const body = vtJmlBody(tableAt, ret)
    body[0] = 0xaf // LDA.L (no ,X) instead of LDA.L addr,X: still a real opcode
    rom.writeAt(detourAt, body)
    rom.writeAt(tableAt & 0x7fffff, table)
    expect(readVerticalTable(rom).ok).toBe(false)
  })

  it('refuses when the read is neither vanilla nor a recognized hook', () => {
    const rom = makeRom()
    rom.writeAt(VT_AT, [0xea, 0xea, 0xea, 0xea, 0x85, 0x5b]) // NOPs where LDA.L belongs
    expect(readVerticalTable(rom).ok).toBe(false)
  })

  it('refuses when the read matches more than once', () => {
    const rom = makeRom()
    rom.writeAt(VT_AT, vtVanilla(0x058417))
    rom.writeAt(0x06c000, vtVanilla(0x058417))
    expect(readVerticalTable(rom).ok).toBe(false)
  })

  // The `BF` opcode is the gate: wildcarding it would still "pass" a table
  // read here (the size check alone would not refuse it), so the opcode
  // itself has to be what's proven to matter.
  it('refuses when the vanilla opcode is not LDA.L (BF)', () => {
    const rom = makeRom()
    rom.writeAt(VT_AT, [0xaf, ...b24(0x058417), 0x85, 0x5b]) // LDA.L (no ,X) instead
    rom.writeAt(0x058417, table)
    expect(readVerticalTable(rom).ok).toBe(false)
  })

  it('notices a write to the same RomFile, in either direction', () => {
    const rom = makeRom()
    expect(readVerticalTable(rom).ok).toBe(false)
    rom.writeAt(VT_AT, vtVanilla(0x058417))
    rom.writeAt(0x058417, table)
    expect(readVerticalTable(rom).ok).toBe(true)
  })
})
