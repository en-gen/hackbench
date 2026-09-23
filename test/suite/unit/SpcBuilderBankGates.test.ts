/**
 * Path gates for the overworld and credits music banks, on synthetic carts.
 *
 * The level bank's gate is covered by SpcBuilderPathGate.test.ts. These two
 * had no gate at all until now, and the credits one is the reason they need
 * one: on all three AddmusicK carts in this repo's corpus the credits upload
 * routine at $008159 is byte-identical to stock and still holds the stock
 * operands, so every check anchored on the routine passes. Nothing calls it.
 * A reader that only looked at the callee would report the stock credits
 * bank for a cartridge that has replaced its music wholesale.
 *
 * CI has no cartridge, so the refusals are proven here; the corpus file
 * beside this one pins what the gates say about the six real carts.
 *
 * Each assertion was proven able to fail by planting the matching defect in
 * src/rom/SpcBuilder.ts; the mutation list is in docs/testing.md.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  getOverworldMusicBankAddrIfReadable,
  getCreditsMusicBankAddrIfReadable,
} from '../../../src/rom/SpcBuilder'

const CART_SIZE = 0x80000

const fileOffset = (snes: number): number => ((snes >> 16) & 0x7f) * 0x8000 + (snes & 0x7fff)

/** LDA #lo : STA $0000 : LDA #hi : STA $0001 : LDA #bank : STA $0002 */
const uploadRoutine = (romAddr: number): number[] => [
  0xa9,
  romAddr & 0xff,
  0x8d,
  0x00,
  0x00,
  0xa9,
  (romAddr >> 8) & 0xff,
  0x8d,
  0x01,
  0x00,
  0xa9,
  (romAddr >> 16) & 0xff,
  0x8d,
  0x02,
  0x00,
]

const jsr = (target: number): number[] => [0x20, target & 0xff, (target >> 8) & 0xff]

interface Plant {
  at: number
  bytes: number[]
}

function rom(...plants: Plant[]): RomFile {
  const buf = Buffer.alloc(CART_SIZE, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode
  for (const { at, bytes } of plants) buf.set(bytes, fileOffset(at))
  return new RomFile('synthetic.sfc', buf)
}

/** The stock call sites and routines for each bank (bank_00.asm:145, 183). */
const BANKS = [
  {
    name: 'overworld',
    read: getOverworldMusicBankAddrIfReadable,
    callSite: 0x0096c3,
    routine: 0x00810e,
    bankAddr: 0x0e98b1,
  },
  {
    name: 'credits',
    read: getCreditsMusicBankAddrIfReadable,
    callSite: 0x0094a0,
    routine: 0x008159,
    bankAddr: 0x03e400,
  },
] as const

describe.each(BANKS)('$name music bank path gate', ({ read, callSite, routine, bankAddr }) => {
  it('reads the bank address when the call site reaches an intact routine', () => {
    const cart = rom(
      { at: callSite, bytes: jsr(routine) },
      { at: routine, bytes: uploadRoutine(bankAddr) },
    )

    expect(read(cart)).toBe(bankAddr)
  })

  it('refuses when the routine is stock but nothing calls it', () => {
    // The measured AddmusicK shape: routine untouched, call site now $80
    // (BRA). Returning bankAddr here is the confident wrong answer.
    const cart = rom(
      { at: callSite, bytes: [0x80, 0x12] },
      { at: routine, bytes: uploadRoutine(bankAddr) },
    )

    expect(read(cart)).toBeNull()
  })

  it('refuses when the call site is absent entirely', () => {
    const cart = rom({ at: routine, bytes: uploadRoutine(bankAddr) })

    expect(read(cart)).toBeNull()
  })

  it('follows the JSR to a relocated routine', () => {
    // A hack that moves the routine but leaves it intact is still readable,
    // which is the whole reason the address comes from the JSR operand.
    const moved = 0x00c400
    const cart = rom(
      { at: callSite, bytes: jsr(moved) },
      { at: moved, bytes: uploadRoutine(bankAddr) },
    )

    expect(read(cart)).toBe(bankAddr)
  })

  it('refuses when the routine the call site reaches is not the upload shape', () => {
    const cart = rom({ at: callSite, bytes: jsr(routine) }, { at: routine, bytes: [0x60] })

    expect(read(cart)).toBeNull()
  })

  it('refuses when the STA operands are repointed away from $00/$01/$02', () => {
    // Opcodes untouched, targets moved: the routine still looks like an
    // upload but no longer builds the pointer readUploadAddress reads.
    const repointed = uploadRoutine(bankAddr)
    repointed[3] = 0x10
    repointed[8] = 0x11
    repointed[13] = 0x12
    const cart = rom({ at: callSite, bytes: jsr(routine) }, { at: routine, bytes: repointed })

    expect(read(cart)).toBeNull()
  })

  it('refuses a callee below $8000, which is WRAM rather than code', () => {
    // Characterising a cross-module invariant, not a guard in SpcBuilder:
    // the refusal comes from loromToOffset, which returns null for any
    // address under $8000 in banks $00-$3F (addressing.ts:51), so the
    // shape gate reads nulls and fails. Asserted here because this is
    // where a caller would notice if that mapping ever changed; planting
    // a defect in SpcBuilder.ts will NOT turn it red, and it is not
    // counted among the gates this file proves.
    const cart = rom(
      { at: callSite, bytes: [0x20, 0x0e, 0x01] },
      { at: routine, bytes: uploadRoutine(bankAddr) },
    )

    expect(read(cart)).toBeNull()
  })
})

describe('the two gates are independent', () => {
  it('reads the credits bank when only the overworld path is broken', () => {
    const cart = rom(
      { at: 0x0094a0, bytes: jsr(0x008159) },
      { at: 0x008159, bytes: uploadRoutine(0x03e400) },
      { at: 0x00810e, bytes: uploadRoutine(0x0e98b1) },
    )

    expect(getCreditsMusicBankAddrIfReadable(cart)).toBe(0x03e400)
    expect(getOverworldMusicBankAddrIfReadable(cart)).toBeNull()
  })
})
