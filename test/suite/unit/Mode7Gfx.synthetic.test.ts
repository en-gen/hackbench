/**
 * Mode7Gfx - the Mode 7 GFX file resolver and its packed-pixel decoder, and
 * the GFX view's use of them.
 *
 * Everything here runs on a synthetic ROM, because CI has no cartridge
 * (CLAUDE.md "CI has no cartridge"). The routine bytes are built from
 * CODE_00AB42 / CODE_00ABC4 / SetallFGBG80 (bank_00.asm:5391-5583) with every
 * operand a parameter, so the tests prove the resolver reads them.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { GFX_FILE_COUNT } from '../../../src/rom/GfxLoader'
import {
  TABLE_BANK,
  TABLE_HI,
  TABLE_LO,
  plantGfxReadPath,
  plantPaletteCol1ReachPath,
} from '../support/syntheticGfxCart'
import { decodeTilesBatch } from '../../../src/rom/GraphicsDecoder'
import { decodeMode7Tiles, findMode7GfxFiles } from '../../../src/rom/Mode7Gfx'
import {
  decodeGfxSheet,
  decodeTiles,
  inferDefaultBpp,
  listGfxFileInfos,
} from '../../../theia/extension/src/node/gfx-decode'

const hex = (s: string): number[] => s.split(/\s+/).map(b => parseInt(b, 16))
const le16 = (n: number): string => `${(n & 0xff).toString(16)} ${((n >> 8) & 0xff).toString(16)}`

/** CODE_00AB42 up to its loop branch, file index, loop count and helper as parameters. */
function unpackBytes(fileIndex: number, loopCount: number, helper: number): number[] {
  const j = le16(helper)
  return hex(
    `a0 ${fileIndex.toString(16)} 22 28 ba 00 c2 10 a0 00 00 a2 ${le16(loopCount)} b7 00 85 0f ` +
      `20 ${j} a5 04 8d 19 21 20 ${j} a5 04 8d 19 21 64 04 26 0f 26 04 26 0f 26 04 c8 ` +
      `b7 00 85 0f 26 0f 26 04 a5 04 8d 19 21 20 ${j} a5 04 8d 19 21 20 ${j} a5 04 8d 19 21 ` +
      `64 04 26 0f 26 04 c8 b7 00 85 0f 26 0f 26 04 26 0f 26 04 a5 04 8d 19 21 ` +
      `20 ${j} a5 04 8d 19 21 20 ${j} a5 04 8d 19 21 c8 ca 10 98`,
  )
}

/** CODE_00ABC4: shift three bits out of _F into _4. */
const HELPER = hex('64 04 26 0f 26 04 26 0f 26 04 26 0f 26 04 60')

/** SetallFGBG80: BEQ + / JSR routine / + LDX #$03 / LDA #$80 / STA abs,X. */
const callSiteBytes = (target: number): number[] =>
  hex(`f0 03 20 ${le16(target)} a2 03 a9 80 9d 05 01`)

const ROUTINE = 0x00ab42
const HELPER_AT = 0x00abc4
const CALLER = 0x00aa5b

interface Layout {
  bank?: number
  routine?: number
  helper?: number
  caller?: number
  fileIndex?: number
  loopCount?: number
  callTarget?: number
}

/** Writes the vanilla-shaped trio into one LoROM bank. */
function writeMode7Load(rom: RomFile, layout: Layout = {}): void {
  const {
    bank = 0x00,
    routine = ROUTINE & 0xffff,
    helper = HELPER_AT & 0xffff,
    caller = CALLER & 0xffff,
    fileIndex = 0x27,
    loopCount = 0x03ff,
    callTarget = routine,
  } = layout
  const at = (addr: number): number => (bank << 16) | addr
  rom.writeAt(at(routine), unpackBytes(fileIndex, loopCount, helper))
  rom.writeAt(at(helper), HELPER)
  rom.writeAt(at(caller), callSiteBytes(callTarget))
}

function makeRom(): RomFile {
  const buf = Buffer.alloc(0x100000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM
  const rom = new RomFile('mock.smc', buf)
  plantGfxReadPath(rom)
  plantPaletteCol1ReachPath(rom)
  return rom
}

function vanillaShaped(): RomFile {
  const rom = makeRom()
  writeMode7Load(rom)
  return rom
}

const UNREADABLE = [{ fileIndex: 0x27, byteLength: null }]

/**
 * Every byte position except the operands the resolver is meant to read,
 * listed here from the ASM and NOT derived from Mode7Gfx's patterns: an
 * oracle read off the implementation loses a position the moment the
 * implementation wildcards it.
 */
const allBut = (length: number, operands: number[]): number[] =>
  Array.from({ length }, (_, i) => i).filter(i => !operands.includes(i))
const JSR_OPERANDS = [19, 20, 27, 28, 59, 60, 67, 68, 99, 100, 107, 108]
// LDY #file, JSL long, LDX #count, then the six JSR operands.
const UNPACK_PINNED = allBut(unpackBytes(0, 0, 0).length, [1, 3, 4, 5, 12, 13, ...JSR_OPERANDS])
const HELPER_PINNED = allBut(HELPER.length, [])
// JSR operand, STA abs,X operand.
const CALL_PINNED = allBut(callSiteBytes(0).length, [3, 4, 10, 11])

const flip = (rom: RomFile, addr: number): void => rom.writeAt(addr, [rom.readByte(addr)! ^ 0xff])

describe('findMode7GfxFiles', () => {
  it('reads the file index and byte length from the operands', () => {
    // ($03FF + 1) iterations of three bytes each.
    expect(findMode7GfxFiles(vanillaShaped())).toEqual([{ fileIndex: 0x27, byteLength: 0xc00 }])
  })

  it('reads a file index and loop count other than the vanilla ones', () => {
    const rom = makeRom()
    writeMode7Load(rom, { fileIndex: 0x1c, loopCount: 0x00ff })
    expect(findMode7GfxFiles(rom)).toEqual([{ fileIndex: 0x1c, byteLength: 0x300 }])
  })

  it('runs the loop body once for an LDX operand with bit 15 set', () => {
    // 16-bit DEX / BPL: $8001 goes to $8000, still negative, and falls out.
    const rom = makeRom()
    writeMode7Load(rom, { loopCount: 0x8001 })
    expect(findMode7GfxFiles(rom)).toEqual([{ fileIndex: 0x27, byteLength: 3 }])
  })

  it('finds the trio after it has been relocated to another bank', () => {
    const rom = makeRom()
    writeMode7Load(rom, { bank: 0x10, routine: 0x9000, helper: 0x9100, caller: 0x8800 })
    expect(findMode7GfxFiles(rom)).toEqual([{ fileIndex: 0x27, byteLength: 0xc00 }])
  })

  it('names nothing when the routine is absent', () => {
    const rom = makeRom()
    rom.writeAt(HELPER_AT, HELPER)
    rom.writeAt(CALLER, callSiteBytes(ROUTINE & 0xffff))
    expect(findMode7GfxFiles(rom)).toEqual([])
  })

  it('names nothing when the file index is past the pointer table', () => {
    const rom = makeRom()
    writeMode7Load(rom, { fileIndex: GFX_FILE_COUNT })
    expect(findMode7GfxFiles(rom)).toEqual([])
  })

  it('names both files but reads neither when two routines make it unclear which runs', () => {
    const rom = vanillaShaped()
    rom.writeAt(0x10a000, unpackBytes(0x1c, 0x03ff, HELPER_AT & 0xffff))
    expect(findMode7GfxFiles(rom)).toEqual([
      { fileIndex: 0x27, byteLength: null },
      { fileIndex: 0x1c, byteLength: null },
    ])
  })

  it('claims the file as unreadable for every pinned byte of the unpack loop', () => {
    // Past the opening, any edit means the packing is no longer known. Each
    // position is its own planted defect: wildcarding any one of them in the
    // pattern leaves exactly one of these unkilled.
    for (const i of UNPACK_PINNED.filter(i => i >= 18)) {
      const rom = vanillaShaped()
      flip(rom, ROUTINE + i)
      expect(findMode7GfxFiles(rom), `offset ${i}`).toEqual(UNREADABLE)
    }
  })

  it('never reads a length when a pinned byte of the opening changes', () => {
    for (const i of UNPACK_PINNED.filter(i => i < 18)) {
      const rom = vanillaShaped()
      flip(rom, ROUTINE + i)
      expect(
        findMode7GfxFiles(rom).every(f => f.byteLength === null),
        `offset ${i}`,
      ).toBe(true)
    }
  })

  it('claims the file as unreadable for every pinned byte of the helper', () => {
    for (const i of HELPER_PINNED) {
      const rom = vanillaShaped()
      flip(rom, HELPER_AT + i)
      expect(findMode7GfxFiles(rom), `offset ${i}`).toEqual(UNREADABLE)
    }
  })

  it('claims the file as unreadable for every pinned byte of the call site', () => {
    for (const i of CALL_PINNED) {
      const rom = vanillaShaped()
      flip(rom, CALLER + i)
      expect(findMode7GfxFiles(rom), `offset ${i}`).toEqual(UNREADABLE)
    }
  })

  it('claims the file as unreadable when any one JSR disagrees about the helper', () => {
    for (const off of JSR_OPERANDS.filter((_, k) => k % 2 === 0)) {
      const rom = vanillaShaped()
      rom.writeAt(ROUTINE + off, [0x00, 0xac])
      expect(findMode7GfxFiles(rom), `offset ${off}`).toEqual(UNREADABLE)
    }
  })

  it('claims the file as unreadable when the call site jumps somewhere else', () => {
    // The hook shape: routine and helper left byte-identical, control
    // diverted at the call. Existing is not the same as reached.
    const rom = makeRom()
    writeMode7Load(rom, { callTarget: 0xf000 })
    expect(findMode7GfxFiles(rom)).toEqual(UNREADABLE)
  })

  it('claims the file as unreadable when two call sites exist', () => {
    const rom = vanillaShaped()
    rom.writeAt(0x00c000, callSiteBytes(ROUTINE & 0xffff))
    expect(findMode7GfxFiles(rom)).toEqual(UNREADABLE)
  })

  it('claims the file as unreadable when the call site is in another bank', () => {
    const rom = vanillaShaped()
    rom.writeAt(CALLER, new Array(12).fill(0xea))
    rom.writeAt(0x018000, callSiteBytes(ROUTINE & 0xffff))
    expect(findMode7GfxFiles(rom)).toEqual(UNREADABLE)
  })

  it('claims the file as unreadable on a HiROM cart, whose bank math it does not do', () => {
    const buf = Buffer.alloc(0x100000, 0x00)
    buf[0xffd5] = 0x21 // HiROM
    buf.set(unpackBytes(0x27, 0x03ff, 0xabc4), 0x2b42)
    buf.set(HELPER, 0x2bc4)
    buf.set(callSiteBytes(0xab42), 0x2a5b)
    expect(findMode7GfxFiles(new RomFile('hirom.smc', buf))).toEqual(UNREADABLE)
  })

  it('re-reads after the ROM is written, not a stale cached answer', () => {
    const rom = vanillaShaped()
    expect(findMode7GfxFiles(rom)[0]!.byteLength).toBe(0xc00)
    flip(rom, HELPER_AT + 2)
    expect(findMode7GfxFiles(rom)).toEqual(UNREADABLE)
  })
})

describe('decodeMode7Tiles', () => {
  it('unpacks three bytes into eight 3-bit pixels, high bits first', () => {
    // 000 001 010 011 100 101 110 111
    const tile = new Array(24).fill(0)
    tile.splice(0, 3, 0x05, 0x39, 0x77)
    const [px] = decodeMode7Tiles(tile)
    expect(Array.from(px!.slice(0, 8))).toEqual([0, 1, 2, 3, 4, 5, 6, 7])
    expect(px!.slice(8).every(p => p === 0)).toBe(true)
  })

  it('lays each tile out as 64 row-major pixels', () => {
    // Pixel 8 is row 1 column 0: the fourth byte's top three bits.
    const tile = new Array(24).fill(0)
    tile[3] = 0b101_00000
    const [px] = decodeMode7Tiles(tile)
    expect(px![8]).toBe(5)
    expect(px![1]).toBe(0)
  })

  it('makes one tile per 24 bytes and drops a partial tail', () => {
    expect(decodeMode7Tiles(new Uint8Array(0xc00)).length).toBe(128)
    expect(decodeMode7Tiles(new Uint8Array(47)).length).toBe(1)
    expect(decodeMode7Tiles(new Uint8Array(23))).toEqual([])
  })
})

/** LZ2 direct-copy stream of `bytes`, in 1024-byte extended chunks. */
function lz2Copy(bytes: number[]): number[] {
  const out: number[] = []
  for (let i = 0; i < bytes.length; i += 1024) {
    const chunk = bytes.slice(i, i + 1024)
    const n = chunk.length - 1
    out.push(0xe0 | ((n >> 8) & 3), n & 0xff, ...chunk)
  }
  return [...out, 0xff]
}

/** A vanilla-shaped ROM whose file $27 decompresses to `length` bytes. */
function romWithFile27(length: number): SmwRom {
  const rom = vanillaShaped()
  const data = Array.from({ length }, (_, i) => [0x05, 0x39, 0x77][i % 3]!)
  const addr = 0x108000
  rom.writeAt(TABLE_LO + 0x27, [addr & 0xff])
  rom.writeAt(TABLE_HI + 0x27, [(addr >> 8) & 0xff])
  rom.writeAt(TABLE_BANK + 0x27, [addr >> 16])
  rom.writeAt(addr, lz2Copy(data))
  return new SmwRom(rom)
}

describe('GFX view (gfx-decode) on the Mode 7 file', () => {
  it('reads the resolved file as mode7 when its length is what the loop consumes', () => {
    expect(inferDefaultBpp(vanillaShaped(), 0x27, 0xc00)).toBe('mode7')
  })

  it('reports the file unavailable when its length disagrees with the loop', () => {
    expect(inferDefaultBpp(vanillaShaped(), 0x27, 0xc00 - 24)).toBeNull()
  })

  it('reports the file unavailable, not planar, when the routine is unreadable', () => {
    const rom = vanillaShaped()
    flip(rom, HELPER_AT + 2)
    expect(inferDefaultBpp(rom, 0x27, 0xc00)).toBeNull()
  })

  it('leaves other files, and every file on a ROM without the routine, to planar inference', () => {
    expect(inferDefaultBpp(vanillaShaped(), 0x26, 0xc00)).toBe(3)
    expect(inferDefaultBpp(makeRom(), 0x27, 0xc00)).toBe(3)
  })

  it('decodes mode7 through the Mode 7 unpacker, not a planar decoder', () => {
    const bytes = Array.from({ length: 48 }, (_, i) => (i * 37) & 0xff)
    expect(decodeTiles(new Uint8Array(bytes), 'mode7')).toEqual(decodeMode7Tiles(bytes))
    expect(decodeTiles(new Uint8Array(bytes), 'mode7')).not.toEqual(decodeTilesBatch(bytes, 3))
  })

  it('decodes the sheet as mode7 by default and on request, 24 bytes per tile', () => {
    const rom = romWithFile27(0xc00)
    const byDefault = decodeGfxSheet(rom, 0x27)
    expect(byDefault.bpp).toBe('mode7')
    expect(byDefault.tileCount).toBe(128)
    expect(decodeGfxSheet(rom, 0x27, 'mode7').tileCount).toBe(128)
  })

  it('lists the file as mode7 with a tile count at 24 bytes per tile', () => {
    const entry = listGfxFileInfos(romWithFile27(0xc00)).find(f => f.index === 0x27)
    expect(entry).toMatchObject({ defaultBpp: 'mode7', byteLength: 0xc00, tileCount: 128 })
  })

  it('refuses to decode an unavailable Mode 7 file unless a format is forced', () => {
    const rom = romWithFile27(0xc00 - 24)
    expect(() => decodeGfxSheet(rom, 0x27)).toThrow()
    expect(decodeGfxSheet(rom, 0x27, 'mode7').tileCount).toBe(127)
  })
})
