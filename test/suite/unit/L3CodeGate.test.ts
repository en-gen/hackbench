/**
 * The layer 3 code gate (#561 review): the renderer's Y values, tilemap pointer
 * read and tide path are the vanilla code's, so a hook on any of them must skip
 * layer 3, and the crusher colors CODE_00A007 copies are read only behind it.
 * Synthetic sites (bytes built here, hashed here); the corpus block runs the
 * real sites against the vanilla cart.
 */
import { createHash } from 'crypto'
import { describe, it, expect } from 'vitest'
import {
  L3_CODE_SITES,
  readCrusherColors,
  readL3CodeGate,
  type CodeSite,
} from '../../../src/rom/L3CodeGate'
import { bgr555ToRgba } from '../../../src/rom/GraphicsDecoder'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { modeTablesRom, sweepLayouts, withLayer3 } from '../support/l3Rom'

const REGION = 0x40
const SITE_A = 0x009fb8
const SITE_B = 0x05c40c
/** Where the synthetic copy loop sits in site A, and the table it names (not the stock address). */
const LOOP_AT = 0x34
const TABLE = 0x00b700
/** Offsets inside site A standing for a Y immediate, the setting read and the pointer operand. */
const SCRIPTED = { immediate: 0x18, jsl: 0x20, pointer: 0x30 }

const hashOf = (rom: RomFile, addr: number) =>
  createHash('sha256')
    .update(Buffer.from(rom.readAt(addr, REGION)!))
    .digest('hex')

/** Two code regions of distinct bytes at their stock addresses, and the site list that fingerprints them. */
function codeRom(): { rom: RomFile; sites: CodeSite[] } {
  const rom = modeTablesRom(sweepLayouts())
  for (const at of [SITE_A, SITE_B]) rom.writeAt(at, Array.from({ length: REGION }, (_, i) => (i * 11 + (at & 0xff)) & 0xff)) // prettier-ignore
  // CODE_00A007's copy loop inside site A, naming the table: LDX #7 / LDA.W table,X / STA.W $071B,X / DEX / BPL.
  rom.writeAt(SITE_A + LOOP_AT, [0xa2, 0x07, 0xbd, TABLE & 0xff, TABLE >> 8, 0x9d, 0x1b, 0x07, 0xca, 0x10, 0xf7]) // prettier-ignore
  const sites = [SITE_A, SITE_B].map(addr => ({ addr, length: REGION, sha256: hashOf(rom, addr) }))
  return { rom, sites }
}

describe('readL3CodeGate (synthetic sites)', () => {
  it('passes the bytes the fingerprints were taken from', () => {
    const { rom, sites } = codeRom()
    expect(readL3CodeGate(rom, sites)).toEqual({ ok: true })
  })

  it('refuses each planted patch: a changed immediate, a JSL at the setting read, a moved pointer read, and the tide routine', () => {
    for (const [what, at] of [
      ['immediate', SITE_A + SCRIPTED.immediate],
      ['jsl at the setting read', SITE_A + SCRIPTED.jsl],
      ['pointer operand', SITE_A + SCRIPTED.pointer],
      ['tide routine', SITE_B + 5],
    ] as const) {
      const { rom, sites } = codeRom()
      rom.writeAt(at, [rom.readByte(at)! ^ 0xff])
      const gate = readL3CodeGate(rom, sites)
      expect(gate, what).toMatchObject({ ok: false, reason: /hooked layer 3 code/ })
    }
  })

  it('reads the JSL bank as $05 when it is $85 (FastROM mirror), and refuses any other bank', () => {
    const { rom, sites } = codeRom()
    const at = SITE_A + SCRIPTED.jsl + 3
    const aliased = sites.map((s, i) => (i === 0 ? { ...s, alias: { at: SCRIPTED.jsl + 3, from: 0x85, to: rom.readByte(at)! } } : s)) // prettier-ignore
    expect(readL3CodeGate(rom, aliased)).toEqual({ ok: true })
    rom.writeAt(at, [0x85])
    expect(readL3CodeGate(rom, aliased)).toEqual({ ok: true })
    for (const other of [0x00, 0x45, 0x84, 0x86, 0xc5]) {
      rom.writeAt(at, [other])
      expect(readL3CodeGate(rom, aliased).ok, `bank ${other}`).toBe(false)
    }
    rom.writeAt(at, [0x85])
    expect(readL3CodeGate(rom, sites).ok, 'without the alias $85 is a patch').toBe(false)
  })

  it('pins the real sites to the ASM they fingerprint: both routines, whole ranges', () => {
    // CODE_009FB8 to CODE_00A045 (bank_00.asm:4139-4217), CODE_05C40C to CODE_05C494 (bank_05.asm:5504-5570).
    expect(L3_CODE_SITES.map(s => [s.addr, s.length])).toEqual([[0x009fb8, 0x00a045 - 0x009fb8], [0x05c40c, 0x05c494 - 0x05c40c]]) // prettier-ignore
    expect(L3_CODE_SITES.every(s => /^[0-9a-f]{64}$/.test(s.sha256))).toBe(true)
    expect(L3_CODE_SITES[0]!.alias).toEqual({ at: 44 + 3, from: 0x85, to: 0x05 }) // JSL CODE_05BC72's bank byte
  })

  it('a hooked graphics loader (no layer 3 chars) skips layer 3 too', () => {
    const { rom, sites } = codeRom()
    withLayer3(rom, { level: 5, tileset: 0, setting: 2, settingsByte: 2, word: 0x2402 })
    const l1 = { header: parseLevelHeader([0, 0, 0, 0, 0]), isVertical: false, colors: [] }
    const gate = readL3CodeGate(rom, sites)
    expect(buildL3Verdict(rom, 5, l1, { ok: true, mode: 1 }, () => [], gate)).toMatchObject({ l3: null, layout: 'standard', reason: 'Layer 3 not drawn yet: hooked layer 3 code' }) // prettier-ignore
  })

  it('a layer 3 GFX file that failed to load (null chars) skips layer 3 too', () => {
    const { rom, sites } = codeRom()
    withLayer3(rom, { level: 5, tileset: 0, setting: 2, settingsByte: 2, word: 0x2402 })
    const l1 = { header: parseLevelHeader([0, 0, 0, 0, 0]), isVertical: false, colors: [] }
    expect(buildL3Verdict(rom, 5, l1, { ok: true, mode: 1 }, () => null, readL3CodeGate(rom, sites))).toMatchObject({ l3: null, reason: 'Layer 3 not drawn yet: hooked layer 3 code' }) // prettier-ignore
  })

  it('refuses when a site lies outside the ROM', () => {
    const { rom, sites } = codeRom()
    expect(readL3CodeGate(rom, [...sites, { addr: 0x7f0000, length: 4, sha256: 'x' }]).ok).toBe(
      false,
    )
  })

  it('a hooked site skips layer 3 on a map that would draw, and names the reason', () => {
    const { rom, sites } = codeRom()
    withLayer3(rom, { level: 5, tileset: 0, setting: 2, settingsByte: 2, word: 0x2402 })
    const l1 = { header: parseLevelHeader([0, 0, 0, 0, 0]), isVertical: false, colors: [] }
    const chars = () => [Array.from({ length: 128 }, () => new Uint8Array(64).fill(1))]
    const draws = () =>
      buildL3Verdict(rom, 5, l1, { ok: true, mode: 1 }, chars, readL3CodeGate(rom, sites))
    expect(draws().l3).not.toBeNull()
    rom.writeAt(SITE_A + SCRIPTED.jsl, [0x22])
    expect(draws()).toMatchObject({ l3: null, layout: 'standard', reason: 'Layer 3 not drawn yet: hooked layer 3 code' }) // prettier-ignore
  })
})

describe('readCrusherColors (synthetic)', () => {
  const words = [0x0123, 0x2345, 0x3456, 0x4567]
  const romWith = (settingsByte: number, tileset = 0) => {
    const { rom, sites } = codeRom()
    withLayer3(rom, { level: 5, tileset, setting: 2, settingsByte, word: 0 })
    // Decoys at the stock table's address and 13 bytes past the named one: reading either is wrong.
    rom.writeAt(0x00b66c, new Array(8).fill(0x77))
    rom.writeAt(TABLE + 13, new Array(8).fill(0x55))
    rom.writeAt(
      TABLE,
      words.flatMap(w => [w & 0xff, w >> 8]),
    )
    return { rom, gate: readL3CodeGate(rom, sites) }
  }

  it('a $80 level gets the table as colors 12-15; any other settings byte gets none', () => {
    const { rom, gate } = romWith(0x80)
    expect(readCrusherColors(rom, 5, 0, gate)).toEqual(words.map(bgr555ToRgba))
    for (const b of [0x02, 0x81, 0xc0]) {
      const r = romWith(b)
      expect(readCrusherColors(r.rom, 5, 0, r.gate), `byte ${b}`).toBeNull()
    }
    expect(readCrusherColors(rom, 6, 0, gate), 'a map with no layer 3').toBeNull()
  })

  it('reads nothing behind a failed gate', () => {
    const { rom } = romWith(0x80)
    expect(readCrusherColors(rom, 5, 0, { ok: false, reason: 'hooked' })).toBeNull()
  })
})

describe.skipIf(!hasRom(VANILLA))('the real sites on the vanilla cart (corpus)', () => {
  it('pass, and layer 3 still draws on exactly the 8 slots it drew before', () => {
    const rom = RomFile.load(romPath(VANILLA))
    expect(readL3CodeGate(rom)).toEqual({ ok: true })
    rom.writeAt(0x009fb8 + 47, [0x85])
    expect(readL3CodeGate(rom), 'FastROM bank').toEqual({ ok: true })
    rom.writeAt(0x009fb8 + 47, [0x45])
    expect(readL3CodeGate(rom).ok).toBe(false)
    rom.writeAt(0x009fb8 + 47, [0x05])
    const smw = new SmwRom(rom)
    const drawn: number[] = []
    for (let id = 0; id < 512; id++) {
      const raw = smw.getLevelRawData(id)
      if (!raw) continue
      const header = parseLevelHeader(raw)
      const v = buildL3Verdict(
        rom,
        id,
        { header, isVertical: false, colors: [] },
        { ok: true, mode: 1 },
      )
      if (v.l3) drawn.push(id)
    }
    expect(drawn).toEqual([0x002, 0x01f, 0x0be, 0x0c1, 0x102, 0x127, 0x1d4, 0x1fc])
  }, 60_000)

  it('a $80 level (vanilla $01F, $1D4, $1FC) gets the crusher colors, and a tide level none', () => {
    const rom = RomFile.load(romPath(VANILLA))
    const smw = new SmwRom(rom)
    const tilesetOf = (id: number) => parseLevelHeader(smw.getLevelRawData(id)!).objectTileset
    // The renderer expands 5-bit channels (c << 3 | c >> 2), so compare the 5-bit values: the castle_crusher
    // palette's 8-bit entries (152,224,224), (0,0,0), (136,88,24), (216,160,56) shifted right by 3.
    const rgb5 = (id: number) => readCrusherColors(rom, id, tilesetOf(id))?.map(c => c.slice(0, 3).map(v => v >> 3)) // prettier-ignore
    for (const id of [0x01f, 0x1d4, 0x1fc]) {
      expect(rgb5(id), `$${id.toString(16)}`).toEqual([[19, 28, 28], [0, 0, 0], [17, 11, 3], [27, 20, 7]]) // prettier-ignore
    }
    expect(rgb5(0x002) ?? null).toBeNull()
  })

  it('a one-byte patch in each real site turns the gate red', () => {
    for (const at of [0x009fb8, 0x009fe0, 0x00a01f + 8, 0x05c40c, 0x05c470]) {
      const rom = RomFile.load(romPath(VANILLA))
      rom.writeAt(at, [rom.readByte(at)! ^ 0xff])
      expect(readL3CodeGate(rom), at.toString(16)).toMatchObject({ ok: false })
    }
  })
})
