/**
 * The screen-exit filing check (#957) on hand-assembled handlers in a synthetic ROM: no corpus.
 * The reference handler is written for this test with different instructions from the game's, so
 * the test holds no ROM bytes; each planted defect is one edit to it and must name a mismatch.
 */
/**
 * The screen-exit filing check (#957) on synthetic carts: no corpus. The cart holds its own load
 * path (loader stub, dispatcher, long-pointer jump, table) and a reference handler, all written
 * with different instructions from the game's, so the test holds no ROM bytes. Each planted
 * defect is one edit to the cart and must be refused with a reason.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { screenExitFilingMismatch } from '../../../src/rom/ScreenExitFiling'
import {
  SCREEN_EXIT_FILING_CODE,
  SCREEN_EXIT_HANDLER_AT,
  SCREEN_EXIT_LOADER_PLANT,
} from '../support/syntheticRom'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const FILING: number[] = [...SCREEN_EXIT_FILING_CODE]
/** Index of the first occurrence of `seq` in the reference handler, so edits follow its layout. */
const at = (...seq: number[]): number => {
  const i = FILING.findIndex((_, k) => seq.every((v, j) => FILING[k + j] === v))
  if (i < 0) throw new Error('reference handler changed')
  return i
}

/** File offset of a LoROM address in this image. */
const off = (snes: number): number => ((snes >> 16) & 0x7f) * 0x8000 + (snes & 0x7fff)

/** The cart's own load path plus `code` as the handler; `edit` patches [address, bytes] pairs over it. */
function cart(code: number[] = FILING, ...patches: [number, number[]][]): RomFile {
  const bytes = new Uint8Array(0x100000)
  bytes[0x7fd5] = 0x20
  for (const [addr, b] of SCREEN_EXIT_LOADER_PLANT) bytes.set(b, off(addr))
  bytes.set(code, off(SCREEN_EXIT_HANDLER_AT))
  for (const [addr, b] of patches) bytes.set(b, off(addr))
  return RomFile.fromBytes('filing.sfc', bytes)
}
/** The reference handler with the bytes at `index` replaced by `to`: one planted defect. */
const edit = (index: number, ...to: number[]): number[] => {
  const c = [...FILING]
  c.splice(index, to.length, ...to)
  return c
}

describe('screenExitFilingMismatch (#957)', () => {
  it('accepts a handler that files per screen, run through the loader, dispatcher and pointer jump', () => {
    expect(screenExitFilingMismatch(cart())).toBeNull()
  })

  const handlers: [string, number[]][] = [
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
          0x6b,
          ...FILING.slice(i),
        ]
      })(),
    ],
    ['returns at once, files nothing', [0x6b]],
    ['never returns', [0x80, 0xfe]],
  ]
  for (const [name, code] of handlers) {
    it(`refuses a handler with a defect: ${name}`, () => {
      expect(screenExitFilingMismatch(cart(code))).toMatch(/Screen exits/)
    })
  }

  // Defects on the load path itself, which the handler-level plants never touch.
  const path: [string, [number, number[]]][] = [
    ['an RTL at the pointer jump', [0x0086fa, [0x6b]]],
    ['a JMP diverting the dispatcher', [0x0da100, [0x4c, 0x06, 0xa1]]],
    ['the table pointing at empty space', [0x0da110, [0x00, 0xb8, 0x0d]]],
    ['the table pointing outside the ROM image', [0x0da110, [0x00, 0x20, 0x7e]]],
    ['the loader stub returning at once', [0x0586e3, [0x60]]],
    ['the pointer jump reading the wrong object number', [0x0086fa, [0xa5, 0x5a]]],
  ]
  for (const [name, patch] of path) {
    it(`refuses a diverted load path: ${name}`, () => {
      expect(screenExitFilingMismatch(cart(FILING, patch))).toMatch(/Screen exits|could not be run/)
    })
  }

  it('says in plain words when the handler files nothing', () => {
    expect(screenExitFilingMismatch(cart(FILING, [0x0086fa, [0x6b]]))).toMatch(/holds .* not the/)
  })
  it('names the refused instruction when the path reaches empty space', () => {
    expect(screenExitFilingMismatch(cart(FILING, [0x0da110, [0x00, 0xb8, 0x0d]]))).toMatch(
      /BRK|refus|executed/i,
    )
  })
  it('caches per ROM version: a write recomputes, an unchanged ROM does not run again', () => {
    const r = cart()
    expect(screenExitFilingMismatch(r)).toBeNull()
    // Bypasses writeAt, so the version is unchanged: a second call must reuse the first result.
    r.buffer[off(SCREEN_EXIT_HANDLER_AT)] = 0x6b
    expect(screenExitFilingMismatch(r)).toBeNull()
    r.writeAt(SCREEN_EXIT_HANDLER_AT, [0x6b]) // a real edit bumps the version and the handler now files nothing
    expect(screenExitFilingMismatch(r)).toMatch(/Screen exits/)
  })
  it('reports the step budget when the handler spins', () => {
    expect(screenExitFilingMismatch(cart([0x80, 0xfe]))).toMatch(/budget|steps/i)
  })
  it('names a mismatch on an image too short to hold the load path', () => {
    const r = RomFile.fromBytes('tiny.sfc', new Uint8Array(0x10))
    expect(screenExitFilingMismatch(r)).toMatch(/Screen exits|could not/)
  })
})

describe.skipIf(!hasRom(VANILLA))('screenExitFilingMismatch -- vanilla ROM (#957)', () => {
  it('finds the stock load path filing as modelled', () => {
    expect(screenExitFilingMismatch(RomFile.load(romPath(VANILLA)))).toBeNull()
  })
})
