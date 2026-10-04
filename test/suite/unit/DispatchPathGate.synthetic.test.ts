/**
 * The object dispatch path is pinned before the stock tables are trusted (#302).
 * A hack that hooks CODE_0DA415 or CODE_0DA106 (bank_0D.asm:1324-1327, 1056-1060)
 * or replaces a per-tileset dispatcher preamble (CODE_0DA44B, bank_0D.asm:1345-1350)
 * no longer reaches the stock tables, so drawing from them is unverified.
 *
 * Synthetic cart, no ROM. The stock bytes below are written here independently
 * of the source's pins, so a pin that drifts from the ASM goes red.
 */
import { describe, it, expect, afterEach } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { createGrid, expandObject } from '../../../src/rom/ObjectExpander'
import type { LevelObject } from '../../../src/rom/LevelParser'
import { productionCart } from '../support/syntheticCart'
import { makeCursor } from '../../../src/rom/objectHandlers/cursor'
import type { InterpretedDraw } from '../../../src/rom/objectHandlers/interpretedDraw'
import {
  dispatchExtended,
  dispatchStandard,
  EXTENDED_HANDLERS,
  STANDARD_HANDLERS,
} from '../../../src/rom/objectHandlers/dispatch'
import {
  ADDR_EXTENDED_DISPATCH,
  ADDR_TILESET_DISPATCH,
} from '../../../src/rom/objectHandlers/romData'

const off = (snes: number): number => ((snes >> 16) & 0x3f) * 0x8000 + (snes & 0x7fff)
const long = (a: number): number[] => [a & 0xff, (a >> 8) & 0xff, a >> 16]

const STD_ENTRY = 0x0da415
const EXT_ENTRY = 0x0da106
const DISPATCHER = 0x0da44b
const STD_BYTES = [0xe2, 0x30, 0xad, 0x31, 0x19, 0x22, 0xfa, 0x86, 0x00]
const EXT_BYTES = [0xe2, 0x30, 0xa5, 0x59, 0xaa, 0x22, 0xfa, 0x86, 0x00]
const DISP_BYTES = [0xe2, 0x30, 0xa6, 0x5a, 0xca, 0x8a, 0x22, 0xfa, 0x86, 0x00]
const FAKE = 0x0dd100

const stockCart = (edit: (b: Buffer) => void = () => {}): RomFile => {
  const b = Buffer.alloc(0x80000, 0)
  b[0x7fd5] = 0x20
  b.set(STD_BYTES, off(STD_ENTRY))
  b.set(EXT_BYTES, off(EXT_ENTRY))
  b.set(long(DISPATCHER), off(ADDR_TILESET_DISPATCH)) // tileset 0
  b.set(DISP_BYTES, off(DISPATCHER))
  b.set(long(FAKE), off(DISPATCHER + 10)) // object 1
  b.set(long(FAKE), off(ADDR_EXTENDED_DISPATCH)) // extended 0
  edit(b)
  return new RomFile('synthetic.sfc', b)
}

let ran = 0
STANDARD_HANDLERS[FAKE] = () => void ran++
EXTENDED_HANDLERS[FAKE] = () => void ran++
afterEach(() => {
  ran = 0
})

function run(rom: RomFile, kind: 'standard' | 'extended'): string[] {
  const unverified: string[] = []
  const cur = makeCursor(createGrid(1), rom, 0, 0, 0, kind === 'standard' ? 1 : 0, 0)
  cur.draw = { unverified } as InterpretedDraw
  if (kind === 'standard') dispatchStandard(cur)
  else dispatchExtended(cur)
  return unverified
}

describe('dispatch path gate (#302)', () => {
  it('stock bytes give no note and still draw', () => {
    expect(run(stockCart(), 'standard')).toEqual([])
    expect(run(stockCart(), 'extended')).toEqual([])
    expect(ran).toBe(2)
  })

  it('one note per map, however many objects', () => {
    const unverified: string[] = []
    const rom = stockCart(b => b.set([0x5c, ...long(0x92ccd2)], off(STD_ENTRY)))
    for (let i = 0; i < 3; i++) {
      const cur = makeCursor(createGrid(1), rom, 0, 0, 0, 1, 0)
      cur.draw = { unverified } as InterpretedDraw
      dispatchStandard(cur)
    }
    expect(unverified).toHaveLength(1)
  })

  it('a JML hook names its target, and drawing still happens', () => {
    const rom = stockCart(b => b.set([0x5c, ...long(0x92ccd2)], off(STD_ENTRY)))
    const notes = run(rom, 'standard')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('$0DA415')
    expect(notes[0]).toContain('$92CCD2')
    expect(ran).toBe(1)
  })

  it('a JML hook on the extended entry is named too', () => {
    const rom = stockCart(b => b.set([0x5c, ...long(0x93aa00)], off(EXT_ENTRY)))
    const notes = run(rom, 'extended')
    expect(notes[0]).toContain('$0DA106')
    expect(notes[0]).toContain('$93AA00')
    expect(ran).toBe(1)
  })

  it('no sink, no throw', () => {
    const rom = stockCart(b => b.set([0x5c, ...long(0x92ccd2)], off(STD_ENTRY)))
    const cur = makeCursor(createGrid(1), rom, 0, 0, 0, 1, 0)
    expect(() => dispatchStandard(cur)).not.toThrow()
  })

  it('accepts the JSL bank byte as $80 (FastROM mirror of ExecutePtrLong)', () => {
    const mirrored = stockCart(b => {
      for (const [at, n] of [
        [STD_ENTRY, 9],
        [EXT_ENTRY, 9],
        [DISPATCHER, 10],
      ])
        b[off(at) + n - 1] = 0x80
    })
    expect(run(mirrored, 'standard')).toEqual([])
    expect(run(mirrored, 'extended')).toEqual([])
  })

  // Every bit of every pinned byte, generated here from the pin list.
  const pins: [string, number, number[], 'standard' | 'extended'][] = [
    ['standard entry', STD_ENTRY, STD_BYTES, 'standard'],
    ['tileset dispatcher preamble', DISPATCHER, DISP_BYTES, 'standard'],
    ['extended entry', EXT_ENTRY, EXT_BYTES, 'extended'],
  ]
  for (const [name, at, bytes, kind] of pins) {
    it(`flipping any bit of the ${name} pins gives a note, and drawing continues`, () => {
      for (let i = 0; i < bytes.length; i++) {
        for (let bit = 0; bit < 8; bit++) {
          // The JSL bank byte $00 and $80 are the same code through the mirror.
          if (i === bytes.length - 1 && bit === 7) continue
          ran = 0
          const rom = stockCart(b => void (b[off(at) + i] ^= 1 << bit))
          const notes = run(rom, kind)
          expect(notes, `${name} byte ${i} bit ${bit}`).toHaveLength(1)
          expect(notes[0]).toContain('$' + at.toString(16).toUpperCase().padStart(6, '0'))
          expect(ran).toBe(1)
        }
      }
    })
  }

  it('reaches the sink through expandObject for an extended object (production wiring)', () => {
    const rom = stockCart(b => b.set([0x5c, ...long(0x93aa00)], off(EXT_ENTRY)))
    const unverified: string[] = []
    const obj = { type: 'extended', objectNumber: 0, settings: 0, x: 0, y: 0 } as LevelObject
    expandObject(createGrid(1), obj, rom, 0, null, undefined, undefined, { unverified } as InterpretedDraw) // prettier-ignore
    expect(unverified).toHaveLength(1)
    expect(unverified[0]).toContain('$0DA106')
  })

  it('a pin read that runs off the ROM says it found nothing', () => {
    const rom = stockCart(b => b.set(long(0x7e0000), off(ADDR_TILESET_DISPATCH)))
    const notes = run(rom, 'standard')
    expect(notes.some(n => n.includes('found nothing'))).toBe(true)
  })

  it('a write after the first dispatch is seen by the next one (cache keyed on version)', () => {
    const rom = stockCart()
    expect(run(rom, 'standard')).toEqual([])
    rom.writeAt(STD_ENTRY, [0x5c, 0xd2, 0xcc, 0x92])
    const notes = run(rom, 'standard')
    expect(notes).toHaveLength(1)
    expect(notes[0]).toContain('JML $92CCD2')
  })

  it('a stock productionCart builder lays out the stock path: no dispatch note, hop included', () => {
    for (const hop of [false, true]) {
      const unverified: string[] = []
      const cur = makeCursor(createGrid(3), productionCart([0x6b], { hop }), 0, 16, 2, 0x12, 0)
      cur.draw = { unverified } as InterpretedDraw
      dispatchStandard(cur)
      dispatchExtended(cur)
      expect(unverified.filter(u => u.startsWith('Object dispatch at'))).toEqual([])
    }
  })
})
