/**
 * Which GFX files UploadGFXFile sends through FilterSomeRAM, read from the ROM
 * (issue #163). Synthetic ROMs build the dispatch from the exported pattern, so
 * no ROM bytes are restated; corpus cases are gated with describe.skipIf.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { WILD } from '../../../src/rom/BytePattern'
import { fingerprint } from '../../../src/rom/Fingerprint'
import {
  FILTER_BODY_LENGTH,
  UPLOAD_GFX_DISPATCH,
  UPLOAD_GFX_OPERANDS,
  filterSomeRamPath,
  loadVram,
  readGfxAssignment,
  GFX_FGBG_TABLE,
} from '../../../src/rom/GfxLoader'
import { encode } from '../../../src/rom/LcLz2'
import { TABLE_BANK, TABLE_HI, TABLE_LO, plantGfxReadPath } from '../support/syntheticGfxCart'
import { hasRom, freshRom, VANILLA } from '../support/corpus'

const DISPATCH_AT = 0x1000 // cart offset in bank 0
const BODY_AT = 0x1100
const BODY = Array.from({ length: FILTER_BODY_LENGTH }, (_, i) => (i * 37 + 5) & 0xff)
const STOCK = [fingerprint(Buffer.from(BODY))!]

interface Operands {
  tilesetMin: number
  tilesetFile: number
  anyFile: number
}
const VANILLA_SHAPE: Operands = { tilesetMin: 0x11, tilesetFile: 0x08, anyFile: 0x1e }

function dispatchBytes(o: Operands, bodyAt = BODY_AT): number[] {
  const b = UPLOAD_GFX_DISPATCH.map(x => (x === WILD ? 0 : x))
  b[UPLOAD_GFX_OPERANDS.tilesetMin] = o.tilesetMin
  b[UPLOAD_GFX_OPERANDS.tilesetFile] = o.tilesetFile
  b[UPLOAD_GFX_OPERANDS.anyFile] = o.anyFile
  b[UPLOAD_GFX_OPERANDS.jmp] = (0x8000 + bodyAt) & 0xff
  b[UPLOAD_GFX_OPERANDS.jmp + 1] = (0x8000 + bodyAt) >> 8
  return b
}

function romWith(o: Operands = VANILLA_SHAPE): RomFile {
  const buf = Buffer.alloc(0x10000)
  buf.set(dispatchBytes(o), DISPATCH_AT)
  buf.set(BODY, BODY_AT)
  return new RomFile('filter.sfc', buf)
}

/** Write at a bank-0 cart offset. */
const poke = (rom: RomFile, at: number, bytes: number[]): void => rom.writeAt(0x8000 + at, bytes)

const path = (rom: RomFile, file: number, tileset: number) =>
  filterSomeRamPath(rom, file, tileset, STOCK)

describe('filterSomeRamPath on synthetic ROMs', () => {
  it('reads the vanilla-shaped operands: file $1E always, $08 from tileset $11', () => {
    const rom = romWith()
    expect(path(rom, 0x1e, 0)).toEqual({ ok: true, filtered: true })
    expect(path(rom, 0x08, 0x10)).toEqual({ ok: true, filtered: false })
    expect(path(rom, 0x08, 0x11)).toEqual({ ok: true, filtered: true })
    expect(path(rom, 0x00, 0x11)).toEqual({ ok: true, filtered: false })
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
    const r = filterSomeRamPath(new RomFile('empty.sfc', Buffer.alloc(0x10000)), 0x1e, 0, STOCK)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not present/)
  })

  it('refuses when the entry is hijacked by a JML', () => {
    const rom = romWith()
    poke(rom, DISPATCH_AT, [0x5c, 0x00, 0x80, 0x10])
    expect(path(rom, 0x1e, 0).ok).toBe(false)
  })

  it('refuses when the dispatch appears twice, rather than picking one', () => {
    const rom = romWith()
    poke(rom, 0x3000, dispatchBytes({ tilesetMin: 0x11, tilesetFile: 0x08, anyFile: 0x2f }))
    const r = path(rom, 0x1e, 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/more than once/)
  })

  it('refuses a trigger file whose FilterSomeRAM is not the stock routine', () => {
    const rom = romWith()
    poke(rom, BODY_AT + 20, [0xea])
    const r = path(rom, 0x1e, 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/FilterSomeRAM/)
    // A file the dispatch does not send there is still a definite no.
    expect(path(rom, 0x00, 0)).toEqual({ ok: true, filtered: false })
  })

  it('refuses a JMP that leaves the ROM', () => {
    const rom = romWith()
    poke(rom, DISPATCH_AT + UPLOAD_GFX_OPERANDS.jmp, [0x00, 0x00])
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
    poke(rom, DISPATCH_AT + i, [UPLOAD_GFX_DISPATCH[i]! ^ 0xff])
    expect(path(rom, 0x1e, 0).ok).toBe(false)
  })

  const body = Array.from({ length: FILTER_BODY_LENGTH }, (_, i) => i)
  it.each(body)('flipping FilterSomeRAM byte %i refuses a trigger file', i => {
    const rom = romWith()
    poke(rom, BODY_AT + i, [BODY[i]! ^ 0xff])
    expect(path(rom, 0x1e, 0).ok).toBe(false)
  })
})

describe('loadVram and the gate', () => {
  // File $1E holds pixel 7 everywhere; FilterSomeRAM would make it 15.
  function gfxRom(o: Operands): RomFile {
    const buf = Buffer.alloc(0x400000)
    buf[0x7fd5] = 0x20
    const rom = new RomFile('vram.sfc', buf)
    plantGfxReadPath(rom)
    poke(rom, DISPATCH_AT, dispatchBytes(o))
    poke(rom, BODY_AT, BODY)
    rom.writeAt(GFX_FGBG_TABLE + 0x11 * 4, [0x00, 0x00, 0x00, 0x1e])
    rom.writeAt(TABLE_LO + 0x1e, [0x00])
    rom.writeAt(TABLE_HI + 0x1e, [0x80])
    rom.writeAt(TABLE_BANK + 0x1e, [0x10])
    rom.writeAt(0x108000, Array.from(encode(new Uint8Array(0xc00).fill(0xff))))
    return rom
  }
  const an1Max = (rom: RomFile): number =>
    Math.max(...loadVram(rom, 0x11).an1!.flatMap(t => [...t]))

  it('leaves file $1E untransformed when the ROM retargets FilterSomeRAM', () => {
    expect(an1Max(gfxRom({ tilesetMin: 0x11, tilesetFile: 0x32, anyFile: 0x32 }))).toBe(7)
  })

  it('draws a trigger file untransformed when its FilterSomeRAM is not stock', () => {
    // The synthetic body is not the stock routine, so the gate refuses $1E.
    expect(an1Max(gfxRom(VANILLA_SHAPE))).toBe(7)
  })
})

describe.skipIf(!hasRom(VANILLA))('vanilla ROM', () => {
  it('reads $1E always and $08 from tileset $11', () => {
    const rom = freshRom()
    expect(filterSomeRamPath(rom, 0x1e, 0)).toEqual({ ok: true, filtered: true })
    expect(filterSomeRamPath(rom, 0x08, 0x10)).toEqual({ ok: true, filtered: false })
    expect(filterSomeRamPath(rom, 0x08, 0x11)).toEqual({ ok: true, filtered: true })
  })

  it('gives every non-zero pixel of the overworld AN1 file plane 3', () => {
    const rom = freshRom()
    expect(readGfxAssignment(rom, 0x11, 0).an1).toBe(0x1e)
    const pixels = loadVram(rom, 0x11).an1!.flatMap(t => Array.from(t))
    expect(pixels.some(p => p !== 0)).toBe(true)
    expect(pixels.every(p => p === 0 || p >= 8)).toBe(true)
  })
})

// The three hacks retarget both files to $32 and rewrite FilterSomeRAM's body.
const RETARGETED = ['Grand Poo World 2 1.1.sfc', 'GrandPooWorld_V1.2.sfc', 'Invictus 1.0.sfc']
describe.each(RETARGETED)('%s', name => {
  describe.skipIf(!hasRom(name))('retargeted ROM', () => {
    it('sends neither $1E nor $08 through FilterSomeRAM', () => {
      const rom = freshRom(name)
      expect(filterSomeRamPath(rom, 0x1e, 0x11)).toEqual({ ok: true, filtered: false })
      expect(filterSomeRamPath(rom, 0x08, 0x11)).toEqual({ ok: true, filtered: false })
    })

    it('refuses $32, whose FilterSomeRAM is not the stock routine', () => {
      expect(filterSomeRamPath(freshRom(name), 0x32, 0).ok).toBe(false)
    })
  })
})
