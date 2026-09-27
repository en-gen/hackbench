/**
 * The GFX READ path asks the ROM the same two questions the save path does
 * (#487): which pointer tables PrepareGraphicsFile names, and whether the
 * decompressor it calls is still the stock LC_LZ2 one. Every ROM here is
 * built in the test, so the gates are proven where CI runs: with no corpus.
 */
import { describe, it, expect } from 'vitest'
import { SmwRom } from '../../../src/rom/SmwRom'
import { RomFile } from '../../../src/rom/RomFile'
import { readGfxFile, loadVram, getLayer3GfxRange, inferGfxBpp } from '../../../src/rom/GfxLoader'
import { GFX_FILE_COUNT } from '../../../src/rom/GfxArena'
import { STOCK_LCLZ2_ENTRY } from '../../../src/rom/GfxDecompressor'
import { GfxTable } from '../../../src/rom/GfxTable'
import { decodeGfxSheet, listGfxFileInfos } from '../../../theia/extension/src/node/gfx-decode'
import { decodeMap16Sheet } from '../../../theia/extension/src/node/map16-decode'
import {
  buildCart,
  DECOMP_ENTRY,
  gfxPayloads,
  L3_CALLERS,
  layer3Routine,
  prepareGraphicsFile,
  TABLE_BANK,
  TABLE_HI,
  TABLE_LO,
} from '../support/syntheticGfxCart'

// Two JSLs and an RTS where the stock prologue sits: the Invictus 1.0 shape,
// written from the 65816 encoding.
const REPLACED_ENTRY = [0x22, 0x00, 0x00, 0x20, 0xea, 0x22, 0x00, 0x00, 0x20, 0x60]

const replacedCart = (): RomFile => buildCart({ entryBytes: REPLACED_ENTRY }).rom

describe('readGfxFile', () => {
  it('reads every file through the tables PrepareGraphicsFile names', () => {
    const rom = buildCart().rom
    const payloads = gfxPayloads()
    for (let i = 0; i < GFX_FILE_COUNT; i++) {
      const r = readGfxFile(rom, i)
      expect(r.ok, `file ${i}`).toBe(true)
      if (r.ok) expect(Array.from(r.bytes)).toEqual(Array.from(payloads[i]!))
    }
  })

  it('follows tables relocated within bank 0 instead of the stock addresses', () => {
    const moved = { lo: 0x9100, hi: 0x9132, bank: 0x9164 }
    const rom = buildCart({
      routine: prepareGraphicsFile(moved.lo, moved.hi, moved.bank),
    }).rom
    for (const [from, to] of [
      [TABLE_LO, moved.lo],
      [TABLE_HI, moved.hi],
      [TABLE_BANK, moved.bank],
    ] as const) {
      rom.writeAt(to, [...rom.readAt(from, GFX_FILE_COUNT)!])
      // Junk at the stock address, so a reader that still looks there fails.
      rom.writeAt(from, new Array<number>(GFX_FILE_COUNT).fill(0xff))
    }
    const r = readGfxFile(rom, 7)
    expect(r.ok).toBe(true)
    if (r.ok) expect(Array.from(r.bytes)).toEqual(Array.from(gfxPayloads()[7]!))
  })

  it('refuses when the decompressor has been replaced, and says why', () => {
    const r = readGfxFile(replacedCart(), 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/LC_LZ2/)
  })

  it('refuses when PrepareGraphicsFile cannot be found', () => {
    const r = readGfxFile(buildCart({ routine: [0x60] }).rom, 0)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/PrepareGraphicsFile/)
  })

  it('notices a write to the same RomFile, in either direction', () => {
    const rom = buildCart().rom
    expect(readGfxFile(rom, 0).ok).toBe(true)
    rom.writeAt(DECOMP_ENTRY, REPLACED_ENTRY)
    expect(readGfxFile(rom, 0).ok).toBe(false)
    rom.writeAt(DECOMP_ENTRY, [...STOCK_LCLZ2_ENTRY])
    expect(readGfxFile(rom, 0).ok).toBe(true)
  })
})

describe('shipping callers on a ROM whose decompressor is replaced', () => {
  it('the Graphics view lists every file unavailable, with the reason', () => {
    for (const f of listGfxFileInfos(new SmwRom(replacedCart()))) {
      expect(f).toMatchObject({ byteLength: 0, defaultBpp: null, tileCount: null })
      expect(f.unavailable).toMatch(/LC_LZ2/)
    }
    expect(listGfxFileInfos(new SmwRom(buildCart().rom))[0]!.unavailable).toBeUndefined()
  })

  it('the Graphics view refuses a sheet with the gate reason, even with a depth forced', () => {
    const rom = new SmwRom(replacedCart())
    expect(() => decodeGfxSheet(rom, 0)).toThrow(/LC_LZ2/)
    expect(() => decodeGfxSheet(rom, 0, 3)).toThrow(/LC_LZ2/)
  })

  it('VRAM holds no sheet decoded by a decompressor the ROM does not run', () => {
    expect(Object.keys(loadVram(buildCart().rom, 0, 0)).length).toBe(8)
    expect(loadVram(replacedCart(), 0, 0)).toEqual({})
  })

  it('the Map16 view reports the sheet unavailable with the gate reason', () => {
    const r = decodeMap16Sheet(new SmwRom(replacedCart()), 0, 'fg', { bg: 0, fg: 0 })
    expect(r.status).toBe('unavailable')
    if (r.status === 'unavailable') expect(r.reason).toMatch(/LC_LZ2/)
  })
})

describe('getLayer3GfxRange', () => {
  it('reads a non-stock count and start from the two LDA #imm operands', () => {
    const rom = buildCart({ l3Routine: layer3Routine(4, 0x30) }).rom
    expect(getLayer3GfxRange(rom)).toEqual({ start: 0x30, end: 0x34 })
  })

  it('refuses on a changed byte anywhere in the pinned routine but the operands', () => {
    const clean = layer3Routine()
    const survived: number[] = []
    for (let i = 0; i < clean.length; i++) {
      if (i === 9 || i === 13) continue // count-1 and first file: the values read
      const routine = [...clean]
      routine[i] = (routine[i]! + 1) & 0xff
      if (getLayer3GfxRange(buildCart({ l3Routine: routine }).rom) !== null) survived.push(i)
    }
    expect(survived).toEqual([])
  })

  it('refuses when either caller no longer reaches the routine', () => {
    // One repointed caller is enough: that path no longer uploads the range
    // read here, so the ROM is not in the shape this reading assumes.
    for (const caller of L3_CALLERS) {
      for (const bytes of [
        [0x20, 0x94, 0xa9], // JSR somewhere else
        [0x22, 0x93, 0xa9], // no longer a JSR
      ]) {
        const rom = buildCart().rom
        rom.writeAt(caller, bytes)
        expect(getLayer3GfxRange(rom), `$${caller.toString(16)}`).toBeNull()
      }
    }
  })

  it('refuses when the routine is absent rather than falling back to $28..$2B', () => {
    expect(getLayer3GfxRange(buildCart({ l3Routine: null }).rom)).toBeNull()
    expect(getLayer3GfxRange(new RomFile('tiny.smc', Buffer.alloc(0x100)))).toBeNull()
  })

  it('leaves a depth that could be 2bpp unknown when the range is unavailable', () => {
    const rom = buildCart({ l3Routine: null }).rom
    expect(inferGfxBpp(rom, 0, 0xc00)).toBeNull()
    // 72 bytes is 3 tiles at 3bpp and no whole number at 2bpp: no L3 question.
    expect(inferGfxBpp(rom, 0, 72)).toBe(3)
  })

  it('names the L3 range as the reason, in the Graphics view and the editor', () => {
    const rom = buildCart({ l3Routine: null }).rom
    expect(() => decodeGfxSheet(new SmwRom(rom), 0)).toThrow(/L3 \(overlay\) GFX range/)
    const op = { kind: 'gfxPixel', file: 0, tile: 0, x: 0, y: 0, value: 1 } as const
    const set = GfxTable.load(rom).setPixel(op)
    expect(set.status).toBe('refused')
    if (set.status === 'refused') expect(set.reason).toMatch(/L3 \(overlay\) GFX range/)
  })
})
