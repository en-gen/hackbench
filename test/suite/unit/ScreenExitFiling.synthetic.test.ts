/**
 * The screen-exit filing check (#957) on hand-assembled handlers in a synthetic ROM: no corpus.
 * The reference handler is written for this test with different instructions from the game's, so
 * the test holds no ROM bytes; each planted defect is one edit to it and must name a mismatch.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import {
  DISPATCH_JSL_AT,
  DISPATCH_SEP_AT,
  screenExitFilingMismatch,
} from '../../../src/rom/ScreenExitFiling'
import { SCREEN_EXIT_FILING_CODE } from '../support/syntheticRom'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const DISPATCH = 0x0d * 0x8000 + 0x210f
const HANDLER = 0x0d * 0x8000 + 0x3000 // $0DB000, off the stock address on purpose

const FILING: number[] = [...SCREEN_EXIT_FILING_CODE]
/** Index of the first occurrence of `seq` in the reference handler, so edits follow its layout. */
const at = (...seq: number[]): number => {
  const i = FILING.findIndex((_, k) => seq.every((v, j) => FILING[k + j] === v))
  if (i < 0) throw new Error('reference handler changed')
  return i
}

/** File offset of a bank $0D address in this LoROM image. */
const off0d = (snes: number): number => 0x0d * 0x8000 + (snes & 0x7fff)

function rom(code: number[], dispatchTo = 0x0db000): RomFile {
  const bytes = new Uint8Array(0x100000)
  bytes[0x7fd5] = 0x20
  bytes[off0d(DISPATCH_SEP_AT)] = 0xe2 // SEP, the dispatcher's first opcode
  bytes[off0d(DISPATCH_SEP_AT) + 1] = 0x30 // SEP #$30: A, X, Y 8-bit
  bytes[off0d(DISPATCH_JSL_AT)] = 0x22 // JSL ExecutePtrLong, whose table follows
  bytes.set([0xfa, 0x86, 0x00], off0d(DISPATCH_JSL_AT) + 1) // its target
  bytes.set([dispatchTo & 0xff, (dispatchTo >> 8) & 0xff, dispatchTo >> 16], DISPATCH)
  bytes.set(code, HANDLER)
  return RomFile.fromBytes('filing.sfc', bytes)
}
const edit = (at: number, ...to: number[]): number[] => {
  const c = [...FILING]
  c.splice(at, to.length, ...to)
  return c
}

describe('screenExitFilingMismatch (#957)', () => {
  it('accepts a handler that files per screen, found through the dispatch pointer', () => {
    expect(screenExitFilingMismatch(rom(FILING))).toBeNull()
  })

  const planted: [string, number[]][] = [
    ['screen mask widened ($3F)', edit(at(0x29, 0x1f), 0x29, 0x3f)],
    ['high byte takes the wrong bit', edit(at(0xa9, 0x00), 0xa9, 0x02)],
    ['secondary flag not shifted', edit(at(0x4a), 0xea)],
    ['pointer not advanced', edit(at(0xe6, 0x65), 0xea, 0xea)],
    // Return before the stores when the screen already holds an exit: the first exit wins.
    [
      'first exit wins',
      (() => {
        const i = at(0xaa) + 1
        return [
          ...FILING.slice(0, i),
          0xbd,
          0xb8,
          0x19,
          0xc9,
          0xee,
          0xf0,
          0x01,
          0x60,
          ...FILING.slice(i),
        ]
      })(),
    ],
    ['returns at once, files nothing', [0x60]],
    ['never returns', [0x80, 0xfe]],
  ]
  for (const [name, code] of planted) {
    it(`names a mismatch: ${name}`, () => {
      expect(screenExitFilingMismatch(rom(code))).toMatch(/Screen exits/)
    })
  }

  it('refuses before running when the dispatcher no longer reads a long-pointer table', () => {
    const r = rom(FILING)
    r.writeAt(DISPATCH_JSL_AT, [0x20]) // JSR: not a long call, so the table is not three-byte entries
    expect(screenExitFilingMismatch(r)).toMatch(/dispatch/)
  })
  it('refuses before running when the dispatcher does not start with SEP', () => {
    const r = rom(FILING)
    r.writeAt(DISPATCH_SEP_AT, [0xea])
    expect(screenExitFilingMismatch(r)).toMatch(/dispatch/)
  })
  it('refuses when the SEP immediate no longer sets 8-bit A and X', () => {
    for (const imm of [0x20, 0x10, 0x00, 0x31]) {
      const r = rom(FILING)
      r.writeAt(DISPATCH_SEP_AT + 1, [imm])
      expect(screenExitFilingMismatch(r)).toMatch(/dispatch.*SEP/)
    }
  })
  it('refuses when the dispatcher calls another routine, in either bank', () => {
    for (const target of [
      [0xfb, 0x86, 0x00],
      [0xfa, 0x87, 0x00],
      [0xfa, 0x86, 0x01],
      [0xfa, 0x86, 0x7e],
    ]) {
      const r = rom(FILING)
      r.writeAt(DISPATCH_JSL_AT + 1, target)
      expect(screenExitFilingMismatch(r)).toMatch(/dispatch.*routine/)
    }
  })
  it('accepts the FastROM mirror of the same routine', () => {
    const r = rom(FILING)
    r.writeAt(DISPATCH_JSL_AT + 1, [0xfa, 0x86, 0x80])
    expect(screenExitFilingMismatch(r)).toBeNull()
  })
  it('reports the step budget when the handler spins', () => {
    expect(screenExitFilingMismatch(rom([0x80, 0xfe]))).toMatch(/budget|steps/i)
  })
  it('names a mismatch when the dispatch points outside the cart', () => {
    expect(screenExitFilingMismatch(rom(FILING, 0x7e2000))).toMatch(/not in the ROM image/)
  })
  it('names a mismatch when the dispatch is unreadable', () => {
    const r = RomFile.fromBytes('tiny.sfc', new Uint8Array(0x10))
    expect(screenExitFilingMismatch(r)).toMatch(/unreadable|could not/)
  })
})

describe.skipIf(!hasRom(VANILLA))('screenExitFilingMismatch -- vanilla ROM (#957)', () => {
  it('finds the stock handler filing as modelled', () => {
    expect(screenExitFilingMismatch(RomFile.load(romPath(VANILLA)))).toBeNull()
  })
})
