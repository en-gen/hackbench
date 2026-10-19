/**
 * Mode7Gfx - the Mode 7 GFX file resolver and its packed-pixel decoder, and
 * the GFX view's use of them.
 *
 * Everything here runs on a synthetic ROM, because CI has no cartridge
 * (CLAUDE.md "CI has no cartridge"). The routine bytes are built from
 * CODE_00AB42 / CODE_00ABC4 / SetallFGBG80 (bank_00.asm:5391-5583) as
 * hand-written code of the same shape (../support/syntheticMode7.ts) with every
 * operand a parameter, so the tests prove the resolver reads them.
 */
import { afterAll, beforeAll, describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { flip } from '../support/syntheticRom'
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
import {
  STOCK_MODE7_FINGERPRINTS,
  decodeMode7Tiles,
  findMode7GfxFiles,
  overrideDefaultMode7Fingerprints,
} from '../../../src/rom/Mode7Gfx'
import {
  ALT_HELPER,
  SYNTH_MODE7_FINGERPRINTS,
  UNPACK_MASK,
  callSiteBytes,
  helperBytes,
  type HelperShape,
  unpackBytes,
} from '../support/syntheticMode7'
import { spanFingerprint } from '../../../src/rom/SubmapFlagGate'
import {
  decodeGfxSheet,
  decodeTiles,
  inferDefaultBpp,
  listGfxFileInfos,
} from '../../../theia/extension/src/node/gfx-decode'

// The carts here hold hand-written code, accepted through injected fingerprints.
// gfx-decode takes none, so its describe installs them as the default through
// the seam, which keeps findMode7GfxFiles' cache in the path.
/** findMode7GfxFiles with the synthetic fingerprints, since the carts hold hand-written code. */
const find = (rom: RomFile): ReturnType<typeof findMode7GfxFiles> =>
  findMode7GfxFiles(rom, SYNTH_MODE7_FINGERPRINTS)

// Not the game's addresses: the call site then does not match the game's bytes either.
const ROUTINE = 0x00b142
const HELPER_AT = 0x00b1c4
const CALLER = 0x00aa5b

interface Layout {
  bank?: number
  routine?: number
  helper?: number
  caller?: number
  fileIndex?: number
  loopCount?: number
  callTarget?: number
  helperShape?: HelperShape
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
  rom.writeAt(at(helper), helperBytes(layout.helperShape))
  rom.writeAt(at(caller), callSiteBytes(callTarget))
}

/** An empty LoROM cart with the GFX read path planted, ready for the trio. */
function makeRom(): RomFile {
  const buf = Buffer.alloc(0x100000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM
  const rom = new RomFile('mock.smc', buf)
  plantGfxReadPath(rom)
  plantPaletteCol1ReachPath(rom)
  return rom
}

/** A cart holding the trio at the vanilla addresses, in the vanilla arrangement. */
function vanillaShaped(): RomFile {
  const rom = makeRom()
  writeMode7Load(rom)
  return rom
}

/** The answer for a file the routine names but whose packing cannot be read. */
const UNREADABLE = [{ fileIndex: 0x27, byteLength: null, reason: expect.any(String) }]

/**
 * Every byte position except the operands the resolver is meant to read,
 * listed here from the ASM and NOT derived from Mode7Gfx's mask: an oracle
 * read off the implementation loses a position the moment the implementation
 * wildcards it.
 */
const allBut = (length: number, operands: number[]): number[] =>
  Array.from({ length }, (_, i) => i).filter(i => !operands.includes(i))
const JSR_OPERANDS = [19, 20, 27, 28, 59, 60, 67, 68, 99, 100, 107, 108]
// LDY #file, JSL long, LDX #count, then the six JSR operands.
const UNPACK_PINNED = allBut(unpackBytes(0, 0, 0).length, [1, 3, 4, 5, 12, 13, ...JSR_OPERANDS])

describe('findMode7GfxFiles', () => {
  it('reads the file index and byte length from the operands', () => {
    // ($03FF + 1) iterations of three bytes each.
    expect(find(vanillaShaped())).toEqual([{ fileIndex: 0x27, byteLength: 0xc00 }])
  })

  it('reads a file index and loop count other than the vanilla ones', () => {
    const rom = makeRom()
    writeMode7Load(rom, { fileIndex: 0x1c, loopCount: 0x00ff })
    expect(find(rom)).toEqual([{ fileIndex: 0x1c, byteLength: 0x300 }])
  })

  it('runs the loop body once for an LDX operand with bit 15 set', () => {
    // 16-bit DEX / BPL: $8001 goes to $8000, still negative, and falls out.
    const rom = makeRom()
    writeMode7Load(rom, { loopCount: 0x8001 })
    expect(find(rom)).toEqual([{ fileIndex: 0x27, byteLength: 3 }])
  })

  it('finds the trio after it has been relocated to another bank', () => {
    const rom = makeRom()
    writeMode7Load(rom, { bank: 0x10, routine: 0x9000, helper: 0x9100, caller: 0x8800 })
    expect(find(rom)).toEqual([{ fileIndex: 0x27, byteLength: 0xc00 }])
  })

  it('names nothing when the routine is absent', () => {
    const rom = makeRom()
    rom.writeAt(HELPER_AT, helperBytes())
    rom.writeAt(CALLER, callSiteBytes(ROUTINE & 0xffff))
    expect(find(rom)).toEqual([])
  })

  it('names nothing when the file index is past the pointer table', () => {
    const rom = makeRom()
    writeMode7Load(rom, { fileIndex: GFX_FILE_COUNT })
    expect(find(rom)).toEqual([])
  })

  it('names both files but reads neither when two routines make it unclear which runs', () => {
    const rom = vanillaShaped()
    rom.writeAt(0x10a000, unpackBytes(0x1c, 0x03ff, HELPER_AT & 0xffff))
    expect(find(rom)).toEqual([
      { fileIndex: 0x27, byteLength: null, reason: expect.any(String) },
      { fileIndex: 0x1c, byteLength: null, reason: expect.any(String) },
    ])
  })

  it('claims the file as changed for every pinned byte of the routine past its opening', () => {
    // The call still reaches a routine that opens LDY / JSL, so a one-byte edit
    // anywhere in the body is refused, never read as planar graphics. Each
    // position is its own planted defect; wildcarding one leaves it unkilled.
    for (const i of UNPACK_PINNED.filter(i => i !== 0 && i !== 2)) {
      const rom = vanillaShaped()
      flip(rom, ROUTINE + i)
      expect(find(rom), `offset ${i}`).toEqual([
        { fileIndex: 0x27, byteLength: null, reason: expect.stringMatching(/changed/) },
      ])
    }
  })

  it('names nothing when the routine no longer opens LDY / JSL', () => {
    for (const i of [0, 2]) {
      const rom = vanillaShaped()
      flip(rom, ROUTINE + i)
      expect(find(rom), `offset ${i}`).toEqual([])
    }
  })

  it('does not claim a branch-over-JSR whose target is not a Mode 7 opening', () => {
    const rom = makeRom()
    rom.writeAt(CALLER, callSiteBytes(0xb000))
    expect(find(rom)).toEqual([])
  })

  it('claims the file as unreadable for a helper that does not shift three bits out', () => {
    const wrong: [string, HelperShape][] = [
      ['two shifts of the input', { asls: 2 }],
      ['four shifts of the input', { asls: 4 }],
      ['a pixel two bits wide', { lsrs: 6 }],
      ['a pixel four bits wide', { lsrs: 4 }],
      ['a store to another byte', { strayStore: 0x20 }],
      ['no return', { hang: true }],
      ['a long return', { rtl: true }],
      ['a hardware write', { hwStore: true }],
      ['a write to cart SRAM', { sramStore: true }],
      ['an OR into an output it did not clear', { orOut: true }],
      ['a read of another byte', { readsOther: true }],
      ['a branch on Y at or above $0100', { readsY: true }],
      ['a hardware read', { hwRead: true }],
      ['an SRAM write that leaves the contents unchanged', { sramRewrite: true }],
      ['a changed Y after reading the output back', { clobbersY: true }],
    ]
    for (const [what, helperShape] of wrong) {
      const rom = makeRom()
      writeMode7Load(rom, { helperShape })
      expect(find(rom), what).toEqual(UNREADABLE)
    }
  })

  it('accepts a differently written helper that has the same effect', () => {
    // Shifts are by three either way; a hash of the stock bytes could not say so.
    const rom = makeRom()
    writeMode7Load(rom)
    rom.writeAt(HELPER_AT, ALT_HELPER)
    expect(find(rom)).toEqual([{ fileIndex: 0x27, byteLength: 0xc00 }])
  })

  it('passes the interpreter refusal through as the reason', () => {
    // A map byte for SA-1: the interpreter runs LoROM only, and says so.
    const rom = vanillaShaped()
    rom.buffer[0x7fd5] = 0x23
    const [file] = find(rom)
    expect(file).toMatchObject({ fileIndex: 0x27, byteLength: null })
    expect(file!.reason).toMatch(/LoROM only/)
  })

  it('reads the stock file normally beside a called LDY / JSL decoy for another file', () => {
    const rom = vanillaShaped()
    rom.writeAt(0x00c000, callSiteBytes(0xb000))
    rom.writeAt(0x00b000, [0xa0, 0x1c, 0x22, 0x01, 0x02, 0x03])
    expect(find(rom)).toEqual([{ fileIndex: 0x27, byteLength: 0xc00 }])
  })

  it('refuses both when a changed routine claims the same file as the stock one', () => {
    const rom = vanillaShaped()
    rom.writeAt(0x00c000, callSiteBytes(0xb000))
    rom.writeAt(0x00b000, [0xa0, 0x27, 0x22, 0x01, 0x02, 0x03])
    expect(find(rom)).toEqual([
      { fileIndex: 0x27, byteLength: null, reason: expect.stringMatching(/more than one/) },
      { fileIndex: 0x27, byteLength: null, reason: expect.stringMatching(/changed/) },
    ])
  })

  it('claims nothing, and leaves the files planar, for two unrelated loaders and no stock routine', () => {
    const rom = makeRom()
    rom.writeAt(0x00b000, [0xa0, 0x1c, 0x22, 0x01, 0x02, 0x03])
    rom.writeAt(0x00b100, [0xa0, 0x1d, 0x22, 0x01, 0x02, 0x03])
    rom.writeAt(0x00c000, callSiteBytes(0xb000))
    rom.writeAt(0x00c100, callSiteBytes(0xb100))
    expect(find(rom)).toEqual([])
    expect(inferDefaultBpp(rom, 0x1c, 0xc00)).toBe(3)
  })

  it('claims a lone edited routine as unavailable when no stock routine exists', () => {
    const rom = makeRom()
    rom.writeAt(0x00b000, [0xa0, 0x1c, 0x22, 0x01, 0x02, 0x03])
    rom.writeAt(0x00c000, callSiteBytes(0xb000))
    expect(find(rom)).toEqual([
      { fileIndex: 0x1c, byteLength: null, reason: expect.stringMatching(/changed/) },
    ])
  })

  it('does not claim a changed routine on a HiROM cart, whose JSR arithmetic it lacks', () => {
    const buf = Buffer.alloc(0x100000, 0x00)
    buf[0xffd5] = 0x21 // HiROM
    buf.set([0xa0, 0x27, 0x22, 0x01, 0x02, 0x03], 0x3142)
    buf.set(callSiteBytes(0xb142), 0x2a5b)
    expect(find(new RomFile('hirom.smc', buf))).toEqual([])
  })

  it('does not claim a changed routine whose file index is past the pointer table', () => {
    const rom = makeRom()
    rom.writeAt(ROUTINE, unpackBytes(0xff, 0x03ff, HELPER_AT & 0xffff))
    flip(rom, ROUTINE + 40)
    rom.writeAt(CALLER, callSiteBytes(ROUTINE & 0xffff))
    expect(find(rom)).toEqual([])
  })

  it('accepts a helper that keeps its loop counter in a 16-bit X', () => {
    // The game calls it with REP #$10 in force; 8-bit X would read LDX #3 as BRK.
    const rom = makeRom()
    writeMode7Load(rom, { helperShape: { wideX: true } })
    expect(find(rom)).toEqual([{ fileIndex: 0x27, byteLength: 0xc00 }])
  })

  it('reads the helper from the byte numbers the routine names, not from fixed ones', () => {
    // The routine's STA / LDA operands point at bytes the helper does not use.
    const rom = makeRom()
    rom.writeAt(ROUTINE, unpackBytes(0x27, 0x03ff, HELPER_AT, { input: 0x40, output: 0x41 }))
    rom.writeAt(HELPER_AT, helperBytes())
    rom.writeAt(CALLER, callSiteBytes(ROUTINE))
    const fps = {
      unpack: [
        spanFingerprint(
          Uint8Array.from(unpackBytes(0, 0, 0, { input: 0x40, output: 0x41 })),
          UNPACK_MASK,
        )!,
      ],
    }
    expect(findMode7GfxFiles(rom, fps)).toEqual(UNREADABLE)
  })

  it('claims the file as unreadable when the routine does not store then load its pixel', () => {
    const rom = makeRom()
    const bytes = unpackBytes(0x27, 0x03ff, HELPER_AT)
    bytes[21] = 0xad // LDA absolute, not direct: the output byte cannot be read
    rom.writeAt(ROUTINE, bytes)
    rom.writeAt(HELPER_AT, helperBytes())
    rom.writeAt(CALLER, callSiteBytes(ROUTINE))
    const variant = Uint8Array.from(bytes.map((v, i) => (UNPACK_MASK.includes(i) ? 0 : v)))
    const fps = { unpack: [spanFingerprint(variant)!] }
    expect(findMode7GfxFiles(rom, fps)).toEqual(UNREADABLE)
  })

  it('claims the file as unreadable for every byte of the call site that makes it a call', () => {
    // BEQ, its distance, JSR, and both operand bytes.
    for (const i of [0, 1, 2, 3, 4]) {
      const rom = vanillaShaped()
      flip(rom, CALLER + i)
      expect(find(rom), `offset ${i}`).toEqual(UNREADABLE)
    }
  })

  it('claims the file as unreadable when any one JSR disagrees about the helper', () => {
    for (const off of JSR_OPERANDS.filter((_, k) => k % 2 === 0)) {
      const rom = vanillaShaped()
      rom.writeAt(ROUTINE + off, [0x00, 0xac])
      expect(find(rom), `offset ${off}`).toEqual(UNREADABLE)
    }
  })

  it('claims the file as unreadable when the call site jumps somewhere else', () => {
    // The hook shape: routine and helper left byte-identical, control
    // diverted at the call. Existing is not the same as reached.
    const rom = makeRom()
    writeMode7Load(rom, { callTarget: 0xf000 })
    expect(find(rom)).toEqual(UNREADABLE)
  })

  it('claims the file as unreadable when two call sites exist', () => {
    const rom = vanillaShaped()
    rom.writeAt(0x00c000, callSiteBytes(ROUTINE & 0xffff))
    expect(find(rom)).toEqual(UNREADABLE)
  })

  it('claims the file as unreadable when the call site is in another bank', () => {
    const rom = vanillaShaped()
    rom.writeAt(CALLER, new Array(8).fill(0xea))
    rom.writeAt(0x018000, callSiteBytes(ROUTINE & 0xffff))
    expect(find(rom)).toEqual(UNREADABLE)
  })

  it('claims the file as unreadable on a HiROM cart, whose bank math it does not do', () => {
    const buf = Buffer.alloc(0x100000, 0x00)
    buf[0xffd5] = 0x21 // HiROM
    buf.set(unpackBytes(0x27, 0x03ff, 0xb1c4), 0x3142)
    buf.set(helperBytes(), 0x31c4)
    buf.set(callSiteBytes(0xb142), 0x2a5b)
    expect(find(new RomFile('hirom.smc', buf))).toEqual([
      { fileIndex: 0x27, byteLength: null, reason: expect.stringMatching(/HiROM/) },
    ])
  })

  it('claims, as changed, a called routine the stock fingerprint does not recognize', () => {
    expect(findMode7GfxFiles(vanillaShaped())).toEqual(UNREADABLE)
  })

  it('holds well-formed stock fingerprints that are not the synthetic ones', () => {
    for (const key of ['unpack'] as const) {
      const stock = STOCK_MODE7_FINGERPRINTS[key]
      expect(stock, key).toHaveLength(1)
      expect(stock[0], key).toMatch(/^[0-9a-f]{64}$/)
      expect(stock[0], key).not.toBe(SYNTH_MODE7_FINGERPRINTS[key][0])
    }
  })

  it('uses the stock fingerprints by default, and the seam replaces then restores them', () => {
    const rom = vanillaShaped()
    expect(findMode7GfxFiles(rom)).toEqual(UNREADABLE)
    overrideDefaultMode7Fingerprints(SYNTH_MODE7_FINGERPRINTS)
    try {
      expect(findMode7GfxFiles(rom)[0]!.byteLength).toBe(0xc00)
    } finally {
      overrideDefaultMode7Fingerprints(null)
    }
    expect(findMode7GfxFiles(rom)).toEqual(UNREADABLE)
  })

  it('re-reads after the ROM is written, not a stale cached answer', () => {
    const rom = vanillaShaped()
    expect(find(rom)[0]!.byteLength).toBe(0xc00)
    flip(rom, HELPER_AT + 2)
    expect(find(rom)).toEqual(UNREADABLE)
  })
})

describe('decodeMode7Tiles', () => {
  it('unpacks three bytes into eight 3-bit pixels, high bits first', () => {
    // 000 001 010 011 100 101 110 111
    const tile = new Array(24).fill(0)
    tile.splice(0, 3, 0x05, 0x39, 0x77)
    const [px] = decodeMode7Tiles(tile)
    expect(Array.from(px!.slice(0, 8))).toEqual(Array.from({ length: 8 }, (_, i) => i))
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
  beforeAll(() => overrideDefaultMode7Fingerprints(SYNTH_MODE7_FINGERPRINTS))
  afterAll(() => overrideDefaultMode7Fingerprints(null))

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

  it('explains a readable routine whose loop length differs from the file', () => {
    const entry = listGfxFileInfos(romWithFile27(0xc00 - 24)).find(f => f.index === 0x27)
    expect(entry).toMatchObject({
      defaultBpp: null,
      unavailable: expect.stringMatching(/reads 3072 bytes but the file holds 3048/),
    })
  })

  it('lists the reason when the routine names the file but cannot be read', () => {
    const rom = romWithFile27(0xc00)
    flip(rom.rom, HELPER_AT + 2)
    const entry = listGfxFileInfos(rom).find(f => f.index === 0x27)
    expect(entry).toMatchObject({ defaultBpp: null, unavailable: expect.stringMatching(/helper/) })
  })

  it('reports a changed routine unavailable in the GFX view, not as planar', () => {
    const rom = vanillaShaped()
    flip(rom, ROUTINE + 40)
    expect(inferDefaultBpp(rom, 0x27, 0xc00)).toBeNull()
  })

  it('refuses to decode an unavailable Mode 7 file unless a format is forced', () => {
    const rom = romWithFile27(0xc00 - 24)
    expect(() => decodeGfxSheet(rom, 0x27)).toThrow()
    expect(decodeGfxSheet(rom, 0x27, 'mode7').tileCount).toBe(127)
  })
})
