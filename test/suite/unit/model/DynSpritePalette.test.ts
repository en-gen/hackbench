/**
 * DynSpritePalette - the CGRAM writes SMW performs at runtime, which the
 * level's static palette does not describe.
 *
 * Test tree
 *   geometry            row / first column derived from the header CGRAM address
 *   readDynPalEntry     entry addressing, bounds, endianness, webview backing
 *   resolveRestingEntry reads the fade's terminal CMP, and its fallbacks
 *   compositeDynPalRow  partial-row splice leaves the rest of the row alone
 *   dynPalToRgba        BGR555 channel order and 5->8 bit replication
 *   ROM                 every MAGIKOOPA_PALS field re-derived from cart bytes
 *
 * The ROM block deliberately derives each field from the *code* that consumes
 * the table (the LDA.L operand, the ASL count, the two header immediates, the
 * terminal CMP) rather than from the table's own contents, so it cannot agree
 * with a wrong constant by reading it back out of the data under test.
 */

import { describe, it, expect } from 'vitest'
import { readFileSync } from 'fs'
import type { RgbaColor } from '../../../../src/rom/GraphicsDecoder'
import { RomFile } from '../../../../src/rom/RomFile'
import {
  MAGIKOOPA_PALS,
  compositeDynPalRow,
  dynPalFirstCol,
  dynPalRow,
  dynPalToRgba,
  readDynPalEntry,
  resolveRestingEntry,
} from '../../../../src/rom/model/palette/DynSpritePalette'
import { VANILLA, hasRom, romPath } from '../../support/corpus'

// -- pure geometry ----------------------------------------------------------

describe('dynPalRow / dynPalFirstCol', () => {
  it('splits the header CGRAM word address into a 16-colour row and column', () => {
    // CGRAM is 256 colours = 16 rows of 16; $2121 takes the colour index.
    expect(dynPalRow({ ...MAGIKOOPA_PALS, cgramStart: 0xf0 })).toBe(15)
    expect(dynPalFirstCol({ ...MAGIKOOPA_PALS, cgramStart: 0xf0 })).toBe(0)
    expect(dynPalRow({ ...MAGIKOOPA_PALS, cgramStart: 0x8a })).toBe(8)
    expect(dynPalFirstCol({ ...MAGIKOOPA_PALS, cgramStart: 0x8a })).toBe(10)
  })

  it('MagiKoopaPals lands on CGRAM row 15 column 0, which is OBJ palette 7', () => {
    // OBJ palette N is CGRAM row 8 + N, so row 15 is OBJ palette 7 - the
    // palette Sprite166EVals[$1F] ($4F & $0F) selects for every $1F tile.
    expect(dynPalRow(MAGIKOOPA_PALS)).toBe(15)
    expect(dynPalFirstCol(MAGIKOOPA_PALS)).toBe(0)
  })

  it('covers only part of the row, so the rest stays level-supplied', () => {
    expect(MAGIKOOPA_PALS.colorsPerEntry).toBeLessThan(16)
    expect(dynPalFirstCol(MAGIKOOPA_PALS) + MAGIKOOPA_PALS.colorsPerEntry).toBeLessThan(16)
  })
})

// -- readDynPalEntry --------------------------------------------------------

/** A synthetic LoROM cart with a recognisable ramp at MAGIKOOPA_PALS.addr. */
function syntheticRom(): RomFile {
  const buf = Buffer.alloc(0x80000)
  const base = ((MAGIKOOPA_PALS.addr >>> 16) & 0x7f) * 0x8000 + (MAGIKOOPA_PALS.addr & 0x7fff)
  for (let e = 0; e < MAGIKOOPA_PALS.entryCount; e++) {
    for (let c = 0; c < MAGIKOOPA_PALS.colorsPerEntry; c++) {
      buf.writeUInt16LE((e << 8) | c, base + e * MAGIKOOPA_PALS.colorsPerEntry * 2 + c * 2)
    }
  }
  return new RomFile('synthetic.sfc', buf)
}

describe('readDynPalEntry', () => {
  it('addresses entry N at addr + N * colorsPerEntry * 2 and reads little-endian', () => {
    const rom = syntheticRom()
    for (let e = 0; e < MAGIKOOPA_PALS.entryCount; e++) {
      expect(readDynPalEntry(rom, MAGIKOOPA_PALS, e)).toEqual(
        Array.from({ length: MAGIKOOPA_PALS.colorsPerEntry }, (_, c) => (e << 8) | c),
      )
    }
  })

  it('returns exactly colorsPerEntry words', () => {
    expect(readDynPalEntry(syntheticRom(), MAGIKOOPA_PALS, 0)).toHaveLength(
      MAGIKOOPA_PALS.colorsPerEntry,
    )
  })

  it('refuses entries outside the table', () => {
    const rom = syntheticRom()
    expect(readDynPalEntry(rom, MAGIKOOPA_PALS, -1)).toBeNull()
    expect(readDynPalEntry(rom, MAGIKOOPA_PALS, MAGIKOOPA_PALS.entryCount)).toBeNull()
  })

  it('reads a RomFile backed by a plain Uint8Array, as the webview builds it', () => {
    // RomFile.ts:22-31: `buffer` is typed Buffer but is a Uint8Array when the
    // webview constructs it from postMessage'd bytes, where Buffer-only
    // methods such as readUInt16LE throw a TypeError rather than returning
    // null. This module is meant to be reusable from either side.
    const host = syntheticRom()
    const view = new RomFile('webview.sfc', new Uint8Array(host.buffer))
    for (let e = 0; e < MAGIKOOPA_PALS.entryCount; e++) {
      expect(readDynPalEntry(view, MAGIKOOPA_PALS, e)).toEqual(
        readDynPalEntry(host, MAGIKOOPA_PALS, e),
      )
    }
    expect(readDynPalEntry(view, MAGIKOOPA_PALS, 0)).not.toBeNull()
  })
})

// -- resolveRestingEntry ----------------------------------------------------

/** A cart whose fade routine ends with `CMP #imm` at `restingEntryCmpAddr`. */
function romWithTerminalCmp(opcode: number, imm: number): RomFile {
  const buf = Buffer.alloc(0x80000)
  const addr = MAGIKOOPA_PALS.restingEntryCmpAddr!
  const off = ((addr >>> 16) & 0x7f) * 0x8000 + (addr & 0x7fff)
  buf[off] = opcode
  buf[off + 1] = imm
  return new RomFile('synthetic.sfc', buf)
}

describe('resolveRestingEntry', () => {
  it('returns the terminal CMP immediate minus two', () => {
    // The fade increments SpriteMisc1570, then uploads entry 1570-1, until
    // 1570 hits the immediate and it branches past the upload instead. So the
    // last entry left in CGRAM is imm - 2. bank_01.asm:8715-8731.
    expect(resolveRestingEntry(romWithTerminalCmp(0xc9, 0x09), MAGIKOOPA_PALS)).toBe(7)
  })

  it('follows a hack that shortens the fade', () => {
    // A cart with `CMP #$05` rests three rungs darker, and the editor must
    // follow rather than keep showing rung 7.
    expect(resolveRestingEntry(romWithTerminalCmp(0xc9, 0x05), MAGIKOOPA_PALS)).toBe(3)
    expect(resolveRestingEntry(romWithTerminalCmp(0xc9, 0x05), MAGIKOOPA_PALS)).not.toBe(
      MAGIKOOPA_PALS.restingEntry,
    )
  })

  it('falls back to the descriptor when the routine is not a CMP immediate', () => {
    // $C5 is CMP dp and $CD is CMP abs: the operand is an address, not the
    // terminal count, so the `- 2` arithmetic no longer describes the
    // routine and the traced literal is the safer answer. The operand byte
    // is deliberately NOT $09 here, so a build that skipped the opcode check
    // would return 3 and fail.
    for (const opcode of [0xc5, 0xcd]) {
      expect(resolveRestingEntry(romWithTerminalCmp(opcode, 0x05), MAGIKOOPA_PALS)).toBe(
        MAGIKOOPA_PALS.restingEntry,
      )
    }
  })

  it('falls back when the immediate would index outside the table', () => {
    for (const imm of [0x00, 0x01, 0xff]) {
      expect(resolveRestingEntry(romWithTerminalCmp(0xc9, imm), MAGIKOOPA_PALS)).toBe(
        MAGIKOOPA_PALS.restingEntry,
      )
    }
  })

  it('falls back when the descriptor names no address', () => {
    const noAddr = { ...MAGIKOOPA_PALS, restingEntryCmpAddr: undefined, restingEntry: 4 }
    expect(resolveRestingEntry(romWithTerminalCmp(0xc9, 0x09), noAddr)).toBe(4)
  })
})

// -- compositeDynPalRow -----------------------------------------------------

const rgba = (n: number): RgbaColor => [n, n, n, 255]

describe('compositeDynPalRow', () => {
  const base = Array.from({ length: 16 }, (_, i) => rgba(i))
  const dyn = Array.from({ length: 8 }, (_, i) => rgba(0x80 + i))

  it('replaces only [firstCol, firstCol + colors) and keeps the rest of the row', () => {
    const out = compositeDynPalRow(base, dyn, 0, [])
    expect(out.slice(0, 8)).toEqual(dyn)
    expect(out.slice(8)).toEqual(base.slice(8))
  })

  it('honours a non-zero first column', () => {
    const out = compositeDynPalRow(base, dyn.slice(0, 2), 4, [])
    expect(out.map(c => c[0])).toEqual([0, 1, 2, 3, 0x80, 0x81, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15])
  })

  it('never writes through the caller-owned base row (Palette.row returns shared scratch)', () => {
    const snapshot = base.map(c => [...c])
    compositeDynPalRow(base, dyn, 0, [])
    expect(base.map(c => [...c])).toEqual(snapshot)
  })

  it('reuses the out buffer across calls without leaking stale colours', () => {
    const out: RgbaColor[] = []
    compositeDynPalRow(base, dyn, 0, out)
    const second = compositeDynPalRow(base, [], 0, out)
    expect(second).toBe(out)
    expect(second).toEqual(base)
  })

  it('drops colours that would run past the end of the row', () => {
    expect(compositeDynPalRow(base, dyn, 12, [])).toHaveLength(16)
  })
})

// -- dynPalToRgba -----------------------------------------------------------

describe('dynPalToRgba - BGR555 channel order', () => {
  it.each([
    ['red   $001F', 0x001f, [255, 0, 0, 255]],
    ['green $03E0', 0x03e0, [0, 255, 0, 255]],
    ['blue  $7C00', 0x7c00, [0, 0, 255, 255]],
    ['black $0000', 0x0000, [0, 0, 0, 255]],
    ['white $7FFF', 0x7fff, [255, 255, 255, 255]],
  ])('%s', (_name, word, expected) => {
    expect(dynPalToRgba([word as number])[0]).toEqual(expected)
  })

  it('bit-replicates 5-bit channels instead of shifting', () => {
    // c5 = 1 -> 8, c5 = 31 -> 255. A plain << 3 would give 248 for 31.
    expect(dynPalToRgba([0x0001])[0][0]).toBe(8)
    expect(dynPalToRgba([0x001f])[0][0]).toBe(255)
  })
})

// -- ROM anchor -------------------------------------------------------------

const ROM_PATH = romPath(VANILLA)
const romPresent = hasRom(VANILLA)

/** LoROM SNES address -> file offset, for a header-free 512KB cart. */
const lorom = (a: number) => ((a >>> 16) & 0x7f) * 0x8000 + (a & 0x7fff)

describe.skipIf(!romPresent)('MAGIKOOPA_PALS ROM anchor (ROM-only)', () => {
  const rom = () => readFileSync(ROM_PATH)

  it('addr is the operand of the LDA.L that reads the table (ROM $01:C036)', () => {
    // CODE_01C028, bank_01.asm:8743. `BF lo hi bank` = LDA.L abs,X.
    const b = rom()
    const at = lorom(0x01c036)
    expect(b[at]).toBe(0xbf)
    expect(b[at + 1] | (b[at + 2] << 8) | (b[at + 3] << 16)).toBe(MAGIKOOPA_PALS.addr)
  })

  it('the entry stride is the four ASLs the index passes through (ROM $01:C02C)', () => {
    // bank_01.asm:8735-8740: `DEC A : ASL A x4 : TAX` scales SpriteMisc1570-1
    // by 1 << 4 = 16 bytes, so an entry is 8 BGR555 colours.
    const b = rom()
    expect([...b.subarray(lorom(0x01c02c), lorom(0x01c02c) + 5)]).toEqual([
      0x0a, 0x0a, 0x0a, 0x0a, 0xaa,
    ])
    expect(MAGIKOOPA_PALS.colorsPerEntry * 2).toBe(1 << 4)
  })

  it('the copy loop and the header both say $10 bytes (ROM $01:C043, $01:C04A)', () => {
    // `CMP #$10` ends the copy; `LDA #$10 : STA DynPaletteTable,X` is the
    // entry length header. bank_01.asm:8749, 8752.
    const b = rom()
    expect([...b.subarray(lorom(0x01c043), lorom(0x01c043) + 2)]).toEqual([
      0xc9,
      MAGIKOOPA_PALS.colorsPerEntry * 2,
    ])
    expect([...b.subarray(lorom(0x01c04a), lorom(0x01c04a) + 2)]).toEqual([
      0xa9,
      MAGIKOOPA_PALS.colorsPerEntry * 2,
    ])
  })

  it('cgramStart is the header CGRAM address immediate (ROM $01:C04F)', () => {
    // `LDA #$F0 : STA DynPaletteTable+1,X`, bank_01.asm:8754. CODE_00A488
    // pushes that byte straight into $2121 at bank_00.asm:4735.
    const b = rom()
    expect([...b.subarray(lorom(0x01c04f), lorom(0x01c04f) + 2)]).toEqual([
      0xa9,
      MAGIKOOPA_PALS.cgramStart,
    ])
  })

  it('entryCount fills exactly the gap up to BooBossPals', () => {
    // BooBossPals is the next label (bank_03.asm:7321); its address is the
    // operand of the LDA.L in CODE_038239 at ROM $03:8254 (bank_03.asm:327).
    const b = rom()
    const at = lorom(0x038254)
    expect(b[at]).toBe(0xbf)
    const booBoss = b[at + 1] | (b[at + 2] << 8) | (b[at + 3] << 16)
    expect(booBoss).toBeGreaterThan(MAGIKOOPA_PALS.addr)
    expect((booBoss - MAGIKOOPA_PALS.addr) / (MAGIKOOPA_PALS.colorsPerEntry * 2)).toBe(
      MAGIKOOPA_PALS.entryCount,
    )
  })

  it('restingEntryCmpAddr is the CMP whose branch skips the upload', () => {
    // CODE_01C004 (bank_01.asm:8715) holds TWO `CMP #$09` and they gate
    // different things. Resolve each one's BNE target rather than trusting
    // the address: they carry the same immediate in vanilla, so anchoring on
    // the wrong one passes for the wrong reason.
    const b = rom()
    const bneTarget = (cmpAddr: number) => {
      const at = lorom(cmpAddr)
      expect(b[at]).toBe(0xc9) // CMP #imm
      expect(b[at + 2]).toBe(0xd0) // BNE rel8
      return cmpAddr + 4 + ((b[at + 3] << 24) >> 24) // PC after BNE + signed rel
    }
    // $01:C014 branches over `LDY #$24 : STY ColorSettings` only
    // (bank_01.asm:8722-8725) and rejoins at the second CMP.
    expect(bneTarget(0x01c014)).toBe(0x01c01c)
    // $01:C01C branches to CODE_01C028 (bank_01.asm:8726-8727), i.e. past
    // the palette upload, which is what fixes the resting entry.
    expect(bneTarget(MAGIKOOPA_PALS.restingEntryCmpAddr!)).toBe(0x01c028)
    // ...and $01:C028 really is the upload: its LDA.L is 14 bytes in.
    expect(b[lorom(0x01c036)]).toBe(0xbf)
  })

  it('restingEntry is the last index the fade-in uploads before state 2', () => {
    const b = rom()
    const at = lorom(MAGIKOOPA_PALS.restingEntryCmpAddr!)
    expect(b[at]).toBe(0xc9)
    expect(b[at + 1] - 2).toBe(MAGIKOOPA_PALS.restingEntry)
  })

  it('resolveRestingEntry on the real cart agrees with the literal', () => {
    expect(resolveRestingEntry(new RomFile(ROM_PATH, rom()), MAGIKOOPA_PALS)).toBe(
      MAGIKOOPA_PALS.restingEntry,
    )
  })

  it('restingEntry is the brightest rung, and the fade rises monotonically', () => {
    // Independent of the index arithmetic above: the table is a fade ramp,
    // so the entry left in CGRAM for the visible state must be its bright end.
    const romFile = new RomFile(ROM_PATH, rom())
    const lum = (entry: number) =>
      (readDynPalEntry(romFile, MAGIKOOPA_PALS, entry) ?? []).reduce(
        (t, w) => t + (w & 0x1f) + ((w >> 5) & 0x1f) + ((w >> 10) & 0x1f),
        0,
      )
    const ramp = Array.from({ length: MAGIKOOPA_PALS.entryCount }, (_, e) => lum(e))
    for (let e = 1; e < ramp.length; e++) expect(ramp[e]).toBeGreaterThan(ramp[e - 1])
    expect(ramp.indexOf(Math.max(...ramp))).toBe(MAGIKOOPA_PALS.restingEntry)
  })

  it('the resting entry really differs from its neighbour, so picking wrong is visible', () => {
    const romFile = new RomFile(ROM_PATH, rom())
    expect(readDynPalEntry(romFile, MAGIKOOPA_PALS, MAGIKOOPA_PALS.restingEntry)).not.toEqual(
      readDynPalEntry(romFile, MAGIKOOPA_PALS, MAGIKOOPA_PALS.restingEntry - 1),
    )
  })
})
