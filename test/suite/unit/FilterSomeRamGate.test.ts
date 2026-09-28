/**
 * Which GFX files UploadGFXFile sends through FilterSomeRAM, read from the ROM
 * (issue #163). Synthetic ROMs build the dispatch from the exported pattern,
 * plus one hand-assembled from the disassembly so the operand offsets are
 * checked against something other than themselves. Corpus cases are gated
 * with describe.skipIf.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { WILD } from '../../../src/rom/BytePattern'
import {
  FILTER_BODY_LENGTH,
  GFX_FGBG_TABLE,
  UPLOAD_GFX_CALLERS,
  UPLOAD_GFX_DISPATCH,
  UPLOAD_GFX_OPERANDS,
  filterSomeRamNote,
  filterSomeRamPath,
  loadVram,
  readGfxAssignment,
} from '../../../src/rom/GfxLoader'
import { encode } from '../../../src/rom/LcLz2'
import {
  FILTER_BODY,
  FILTER_BODY_AT,
  FILTER_BODY_SHA,
  PREPARE_GFX,
  TABLE_BANK,
  TABLE_HI,
  TABLE_LO,
  UPLOAD_GFX_ENTRY,
  VANILLA_FILTER,
  filterDispatch,
  jsl,
  plantFilterSomeRam,
  plantGfxReadPath,
} from '../support/syntheticGfxCart'
import { hasRom, freshRom, VANILLA, MAGIC } from '../support/corpus'

/** A ROM with PrepareGraphicsFile and a stock-shaped UploadGFXFile path. */
function romWith(o = VANILLA_FILTER): RomFile {
  const rom = new RomFile('filter.sfc', Buffer.alloc(0x10000))
  plantGfxReadPath(rom)
  plantFilterSomeRam(rom, o)
  return rom
}

const path = (rom: RomFile, file: number, tileset: number) =>
  filterSomeRamPath(rom, file, tileset, FILTER_BODY_SHA)

const refusal = (rom: RomFile, file = 0x1e): string => {
  const r = path(rom, file, 0)
  return r.ok ? 'not refused' : r.reason
}

describe('filterSomeRamPath on synthetic ROMs', () => {
  it('reads the vanilla-shaped operands: file $1E always, $08 from tileset $11', () => {
    const rom = romWith()
    expect(path(rom, 0x1e, 0)).toEqual({ ok: true, filtered: true })
    expect(path(rom, 0x08, 0x10)).toEqual({ ok: true, filtered: false })
    expect(path(rom, 0x08, 0x11)).toEqual({ ok: true, filtered: true })
    expect(path(rom, 0x00, 0x11)).toEqual({ ok: true, filtered: false })
  })

  it('reads each operand from its own instruction, hand-assembled from bank_00.asm:5412-5422', () => {
    const rom = romWith({ tilesetMin: 0, tilesetFile: 0, anyFile: 0 })
    // CPX #$11 / BCC +4 / CPY #$08 / BEQ +6 / CPY #$1E / BEQ +2 / BNE +3 / JMP FilterSomeRAM
    // prettier-ignore
    rom.writeAt(UPLOAD_GFX_ENTRY + 29, [0xe0, 0x11, 0x90, 0x04, 0xc0, 0x08, 0xf0, 0x06,
      0xc0, 0x1e, 0xf0, 0x02, 0xd0, 0x03, 0x4c, FILTER_BODY_AT & 0xff, FILTER_BODY_AT >> 8])
    expect(path(rom, 0x08, 0x10)).toEqual({ ok: true, filtered: false })
    expect(path(rom, 0x08, 0x11)).toEqual({ ok: true, filtered: true })
    expect(path(rom, 0x1e, 0x00)).toEqual({ ok: true, filtered: true })
    expect(path(rom, 0x11, 0x00)).toEqual({ ok: true, filtered: false })
  })

  it('follows retargeted files and threshold instead of $1E/$08/$11', () => {
    const rom = romWith({ tilesetMin: 0x05, tilesetFile: 0x21, anyFile: 0x32 })
    expect(path(rom, 0x1e, 0)).toEqual({ ok: true, filtered: false })
    expect(path(rom, 0x08, 0x11)).toEqual({ ok: true, filtered: false })
    expect(path(rom, 0x32, 0)).toEqual({ ok: true, filtered: true })
    expect(path(rom, 0x21, 0x04)).toEqual({ ok: true, filtered: false })
    expect(path(rom, 0x21, 0x05)).toEqual({ ok: true, filtered: true })
  })

  it('refuses when the dispatch is absent', () => {
    expect(refusal(new RomFile('empty.sfc', Buffer.alloc(0x10000)))).toMatch(/not present/)
  })

  it('refuses when the entry is hijacked by a JML', () => {
    const rom = romWith()
    rom.writeAt(UPLOAD_GFX_ENTRY, [0x5c, 0x00, 0x80, 0x00])
    expect(path(rom, 0x1e, 0).ok).toBe(false)
  })

  it('refuses when the dispatch appears twice, rather than picking one', () => {
    const rom = romWith()
    rom.writeAt(0x00b000, filterDispatch({ ...VANILLA_FILTER, anyFile: 0x2f }))
    expect(refusal(rom)).toMatch(/more than once/)
  })

  it('refuses a match that straddles a bank boundary', () => {
    const rom = romWith()
    rom.writeAt(UPLOAD_GFX_ENTRY, [0, 0, 0, 0])
    plantFilterSomeRam(rom, VANILLA_FILTER, 0x00ffe0)
    expect(refusal(rom)).toMatch(/straddles/)
  })

  it.each(UPLOAD_GFX_CALLERS)('refuses when the JSR at %i no longer calls the match', c => {
    const rom = romWith()
    rom.writeAt(c, [0x20, 0x00, 0x90])
    expect(refusal(rom)).toMatch(/upload loops call/)
  })

  it('refuses when the entry JSL does not reach the stock PrepareGraphicsFile', () => {
    const rom = romWith()
    rom.writeAt(UPLOAD_GFX_ENTRY, jsl(0x009000))
    expect(refusal(rom)).toMatch(/PrepareGraphicsFile/)
    rom.writeAt(UPLOAD_GFX_ENTRY, jsl(PREPARE_GFX | 0x800000)) // the FastROM mirror is the same code
    expect(path(rom, 0x1e, 0)).toEqual({ ok: true, filtered: true })
  })

  it('refuses a trigger file whose FilterSomeRAM is not the stock routine', () => {
    const rom = romWith()
    rom.writeAt(FILTER_BODY_AT + 20, [0xea])
    expect(refusal(rom)).toMatch(/FilterSomeRAM/)
    // A file the dispatch does not send there is still a definite no.
    expect(path(rom, 0x00, 0)).toEqual({ ok: true, filtered: false })
  })

  it('refuses a JMP that leaves the ROM', () => {
    const rom = romWith()
    rom.writeAt(UPLOAD_GFX_ENTRY + UPLOAD_GFX_OPERANDS.jmp, [0x00, 0x00])
    expect(path(rom, 0x1e, 0).ok).toBe(false)
  })

  it('never falls back to the vanilla pair on a ROM that cannot be read', () => {
    const rom = new RomFile('tiny.sfc', Buffer.alloc(0x100))
    expect(filterSomeRamPath(rom, 0x1e, 0).ok).toBe(false)
  })
})

describe('every pinned byte of the gate', () => {
  const pinned = UPLOAD_GFX_DISPATCH.flatMap((b, i) => (b === WILD ? [] : [i]))
  it.each(pinned)('flipping dispatch byte %i refuses', i => {
    const rom = romWith()
    rom.writeAt(UPLOAD_GFX_ENTRY + i, [UPLOAD_GFX_DISPATCH[i]! ^ 0xff])
    expect(path(rom, 0x1e, 0).ok).toBe(false)
  })

  const body = Array.from({ length: FILTER_BODY_LENGTH }, (_, i) => i)
  it.each(body)('flipping FilterSomeRAM byte %i refuses a trigger file', i => {
    const rom = romWith()
    rom.writeAt(FILTER_BODY_AT + i, [FILTER_BODY[i]! ^ 0xff])
    expect(path(rom, 0x1e, 0).ok).toBe(false)
  })
})

describe('loadVram and the gate', () => {
  // File $1E, in the AN1 slot at tileset $11, holds pixel 7; FilterSomeRAM makes it 15.
  function gfxRom(o = VANILLA_FILTER): RomFile {
    const buf = Buffer.alloc(0x400000)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('vram.sfc', buf)
    plantGfxReadPath(rom)
    plantFilterSomeRam(rom, o)
    rom.writeAt(GFX_FGBG_TABLE + 0x11 * 4, [0x00, 0x00, 0x00, 0x1e])
    rom.writeAt(TABLE_LO + 0x1e, [0x00])
    rom.writeAt(TABLE_HI + 0x1e, [0x80])
    rom.writeAt(TABLE_BANK + 0x1e, [0x10])
    rom.writeAt(0x108000, Array.from(encode(new Uint8Array(0xc00).fill(0xff))))
    return rom
  }
  const an1Max = (rom: RomFile, stock?: string[]): number =>
    Math.max(...loadVram(rom, 0x11, 0, stock).an1!.flatMap(t => [...t]))

  it('applies the transform to a trigger file whose FilterSomeRAM is stock', () => {
    expect(an1Max(gfxRom(), FILTER_BODY_SHA)).toBe(15)
  })

  it('leaves file $1E untransformed when the ROM retargets FilterSomeRAM', () => {
    expect(an1Max(gfxRom({ ...VANILLA_FILTER, anyFile: 0x32 }), FILTER_BODY_SHA)).toBe(7)
  })

  it('draws a refused trigger file as decoded, and the note says why', () => {
    const rom = gfxRom()
    expect(an1Max(rom)).toBe(7)
    expect(filterSomeRamNote(rom, 0x11)).toMatch(/drawn as stored, unverified.*FilterSomeRAM/)
    expect(filterSomeRamNote(rom, 0x11, 0, FILTER_BODY_SHA)).toBeUndefined()
    expect(filterSomeRamNote(rom, 0x00)).toBeUndefined() // no trigger file in this tileset
  })
})

describe.each([VANILLA, MAGIC])('%s', name => {
  describe.skipIf(!hasRom(name))('stock ROM', () => {
    it('reads $1E always and $08 from tileset $11', () => {
      const rom = freshRom(name)
      expect(filterSomeRamPath(rom, 0x1e, 0)).toEqual({ ok: true, filtered: true })
      expect(filterSomeRamPath(rom, 0x08, 0x10)).toEqual({ ok: true, filtered: false })
      expect(filterSomeRamPath(rom, 0x08, 0x11)).toEqual({ ok: true, filtered: true })
      expect(filterSomeRamNote(rom, 0x11)).toBeUndefined()
    })

    it('gives every non-zero pixel of the overworld AN1 file plane 3', () => {
      const rom = freshRom(name)
      expect(readGfxAssignment(rom, 0x11, 0).an1).toBe(0x1e)
      const pixels = loadVram(rom, 0x11).an1!.flatMap(t => Array.from(t))
      expect(pixels.some(p => p !== 0)).toBe(true)
      expect(pixels.every(p => p === 0 || p >= 8)).toBe(true)
    })
  })
})

// These JSL into other code instead of PrepareGraphicsFile, so Y is not known to hold the file.
const JSL_ELSEWHERE = [
  'Grand Poo World 2 1.1.sfc',
  'GrandPooWorld_V1.2.sfc',
  'Invictus 1.0.sfc',
  'Seven_Vanilla_Levels.sfc',
]
describe.each(JSL_ELSEWHERE)('%s', name => {
  describe.skipIf(!hasRom(name))('JSL elsewhere', () => {
    it('refuses, with a note, rather than read the triggers', () => {
      const rom = freshRom(name)
      const r = filterSomeRamPath(rom, 0x1e, 0x11)
      expect(r.ok ? '' : r.reason).toMatch(/does not call the stock PrepareGraphicsFile/)
      expect(filterSomeRamNote(rom, 0x11)).toMatch(/unverified/)
    })
  })
})
