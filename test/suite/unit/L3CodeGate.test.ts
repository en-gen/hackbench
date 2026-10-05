/**
 * The layer 3 code gate (#561 review): the renderer's Y values, tilemap pointer
 * read and tide path are the vanilla code's, so a hook on any of them must skip
 * layer 3, and the crusher colors CODE_00A007 copies are read only behind it.
 * Synthetic sites (bytes built here, hashed here); the corpus block runs the
 * real sites against the vanilla cart.
 */
import { createHash } from 'crypto'
import { describe, it, expect } from 'vitest'
import { readCrusherColors, readL3CodeGate, type CodeSite } from '../../../src/rom/L3CodeGate'
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
  const TABLE = 0x00b67f
  const words = [0x0123, 0x2345, 0x3456, 0x4567]
  const romWith = (settingsByte: number, tileset = 0) => {
    const { rom, sites } = codeRom()
    withLayer3(rom, { level: 5, tileset, setting: 2, settingsByte, word: 0 })
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

  it('a one-byte patch in each real site turns the gate red', () => {
    for (const at of [0x009fb8, 0x009fe0, 0x00a01f + 8, 0x05c40c, 0x05c470]) {
      const rom = RomFile.load(romPath(VANILLA))
      rom.writeAt(at, [rom.readByte(at)! ^ 0xff])
      expect(readL3CodeGate(rom), at.toString(16)).toMatchObject({ ok: false })
    }
  })
})
