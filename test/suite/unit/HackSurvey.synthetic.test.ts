/**
 * hack-survey figures (#543) on built bytes, so CI needs no ROM. Each planted
 * defect must move exactly its own figure, which is the proof the survey can
 * fail: a survey that counted nothing would report 0 for every figure and pass
 * a "clean" case, so the clean case pins non-zero expectations too.
 */
import { describe, it, expect } from 'vitest'
import { calibrate, figures, offsetOf, surveyRom } from '../../../tools/scripts/hackSurvey'

const SIZE = 0x100000
const put = (rom: Uint8Array, addr: number, bytes: readonly number[]) => {
  const off = offsetOf(addr, SIZE)!
  rom.set(bytes, off)
}
const APP_READ = [
  0x29, 0x06, 0x00, 0xaa, 0xa9, 0x33, 0x01, 0x0a, 0xa8, 0xa9, 0x07, 0x00, 0x85, 0x00, 0xbf, 0x00,
  0x80, 0x0e, 0x99, 0xbe, 0x0f, 0xc8, 0xc8, 0x18, 0x69, 0x08, 0x00, 0xc6, 0x00, 0x10, 0xf3,
]
const SPRITE_LEAD = [0xb9, 0x00, 0xec, 0x85, 0xce, 0xb9, 0x01, 0xec, 0x85, 0xcf]

function vanilla(): Uint8Array {
  const rom = new Uint8Array(SIZE).fill(0xea)
  put(rom, 0x058000, APP_READ)
  put(rom, 0x058800, APP_READ)
  put(rom, 0x05ec00 - 0x100, SPRITE_LEAD)
  put(rom, 0x05d8b1, [0xf0])
  put(rom, 0x0da415, [0xa5, 0x59, 0x0a, 0xaa])
  for (let i = 0; i < 63; i++) put(rom, 0x0da455 + i * 3, [i, 0x80, 0x0d])
  return rom
}
/** A hack as Lunar Magic leaves it: JSL at $05D8B1 and a version marker. */
function hack(edit: (rom: Uint8Array) => void = () => {}): Uint8Array {
  const rom = vanilla()
  put(rom, 0x05d8b1, [0x22])
  put(
    rom,
    0x0ff0a0,
    [...'Lunar Magic Version 3.30'].map(c => c.charCodeAt(0)),
  )
  edit(rom)
  return rom
}
const survey = (rom: Uint8Array) => figures([surveyRom(vanilla(), rom, calibrate(vanilla()))])

describe('hack survey figures (synthetic)', () => {
  it('a clean Lunar Magic hack counts as held, JSL, marked, stock dispatch and nothing else', () => {
    expect(survey(hack())).toEqual({
      n: 1,
      coreHeld: 1,
      spriteTableUnresolved: 0,
      lz2Replaced: 0,
      appReaderMoved: 0,
      jslAt05D8B1: 1,
      handlersAllIn8D: 0,
      lmMarker: 1,
      dispatch: { stock: 1, jml: 0, other: 0 },
      sa1Remap: 0,
    })
  })

  const planted: [string, (rom: Uint8Array) => void, Partial<ReturnType<typeof survey>>][] = [
    ['an edited core table', r => put(r, 0x05b96b, [1]), { coreHeld: 0 }],
    ['a replaced LC_LZ2 entry', r => put(r, 0x00b8de, [0x5c]), { lz2Replaced: 1 }],
    ['a removed MAP16AppTable reader', r => put(r, 0x058800, [0xea]), { appReaderMoved: 1 }],
    ['no JSL at $05D8B1', r => put(r, 0x05d8b1, [0xf0]), { jslAt05D8B1: 0 }],
    [
      'all handlers in the $8D mirror',
      r => {
        for (let i = 0; i < 63; i++) put(r, 0x0da455 + i * 3 + 2, [0x8d])
      },
      { handlersAllIn8D: 1 },
    ],
    ['no version marker', r => put(r, 0x0ff0a0, [0x00]), { lmMarker: 0 }],
    [
      'a JML at the dispatch',
      r => put(r, 0x0da415, [0x5c, 0, 0, 0x92]),
      { dispatch: { stock: 0, jml: 1, other: 0 } },
    ],
    [
      'the SA-1 remap at the dispatch',
      r => put(r, 0x0da415, [0xe2, 0x30, 0xad, 0x31, 0x79, 0x22, 0xfa, 0x86, 0x00]),
      { dispatch: { stock: 0, jml: 0, other: 1 }, sa1Remap: 1 },
    ],
  ]
  for (const [name, edit, delta] of planted) {
    it(`${name} moves its figure and only its figure`, () => {
      const clean = survey(hack())
      const got = survey(hack(edit))
      expect(got).toEqual({ ...clean, ...delta })
      expect(got).not.toEqual(clean)
    })
  }
})
