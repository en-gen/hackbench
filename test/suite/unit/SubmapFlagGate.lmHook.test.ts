/**
 * Lunar Magic's JSL at $05D8B1 and the routine it reaches, on synthetic ROMs:
 * the mapping is read from the routine's own operands, every pinned byte is
 * load-bearing, and the exit graph takes a root's flag from its map.
 */
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { afterEach, describe, expect, it } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { WILD } from '../../../src/rom/BytePattern'
import { LM_ENTRY_HOOK, LM_ENTRY_SITE, readTranslevelBias } from '../../../src/rom/SubmapFlagGate'
import {
  blankStockRom,
  plantLmEntryHook,
  SYNTHETIC_FINGERPRINTS,
  writeSyntheticRom,
} from '../support/syntheticRom'

function hooked(opts?: Parameters<typeof plantLmEntryHook>[1]): RomFile {
  const rom = blankStockRom()
  plantLmEntryHook(rom, opts)
  return rom
}
const read = (rom: RomFile): ReturnType<typeof readTranslevelBias> =>
  readTranslevelBias(rom, SYNTHETIC_FINGERPRINTS.entry)

describe('readTranslevelBias: Lunar Magic entry hook', () => {
  it("reads the routine's operands, not the stock site's", () => {
    // The stock site keeps $25/$24; the routine overwrites what they computed.
    expect(read(hooked({ threshold: 0x30, bias: 0x2a }))).toEqual({
      ok: true,
      threshold: 0x30,
      bias: 0x2a,
      submapHigh: 1,
      high: 'translevel',
    })
  })

  it.each([0x05e900, 0x85dcd0])('follows the JSL to $%s', at => {
    expect(read(hooked({ at })).ok).toBe(true)
  })

  it('refuses a JSL that reaches anything but the routine', () => {
    const rom = hooked()
    rom.writeAt(0x05d8b2, [0x00, 0xe9])
    const r = read(rom)
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toContain("not Lunar Magic's high-byte routine")
  })

  it('refuses a JML in place of the JSL', () => {
    const rom = hooked()
    rom.writeAt(0x05d8b1, [0x5c])
    expect(read(rom).ok).toBe(false)
  })

  it('does not excuse the path into the site', () => {
    const rom = hooked()
    rom.writeAt(0x05d7b0, [0x5c])
    expect(read(rom).ok).toBe(false)
  })

  const pinned = (p: readonly number[]): number[] => p.flatMap((b, i) => (b === WILD ? [] : [i]))
  it.each(pinned(LM_ENTRY_SITE.bytes))('refuses with site byte %i flipped', i => {
    const rom = hooked()
    rom.writeAt(LM_ENTRY_SITE.addr + i, [LM_ENTRY_SITE.bytes[i]! ^ 0xff])
    expect(read(rom).ok).toBe(false)
  })
  it.each(pinned(LM_ENTRY_HOOK))('refuses with routine byte %i flipped', i => {
    const rom = hooked()
    rom.writeAt(0x05dcd0 + i, [LM_ENTRY_HOOK[i]! ^ 0xff])
    expect(read(rom).ok).toBe(false)
  })
})

describe('buildLevelExitGraph under the hook', () => {
  let dir: string | null = null
  afterEach(() => {
    if (dir) fs.rmSync(dir, { recursive: true, force: true })
    dir = null
  })
  const graphFor = (hook: boolean, roots: { main: number[]; sub: number[] }) => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-lmhook-'))
    const rooms = new Map([
      [0x00c, [0x050]],
      [0x050, []],
      [0x150, []],
    ])
    const smw = SmwRom.open(writeSyntheticRom(dir, rooms))
    if (hook) plantLmEntryHook(smw.rom)
    return smw.buildLevelExitGraph(
      { main: new Set(roots.main), sub: new Set(roots.sub) },
      SYNTHETIC_FINGERPRINTS.entry,
    )
  }

  it("takes a $0xx submap root's exits into $1xx, where the stock rule keeps $0xx", () => {
    expect(graphFor(true, { main: [], sub: [0x00c] }).graph.get(0x00c)).toEqual([0x150])
    expect(graphFor(false, { main: [], sub: [0x00c] }).graph.get(0x00c)).toEqual([0x050])
  })

  it('refuses a root entered from both maps', () => {
    expect(graphFor(true, { main: [0x00c], sub: [0x00c] }).unavailable).toContain('both maps')
  })
})
