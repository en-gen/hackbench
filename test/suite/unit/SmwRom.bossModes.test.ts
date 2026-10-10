/**
 * levelHasObjects and the boss-mode exemption (#695). LoadLevel never reads
 * Layer 1 for its boss modes (SMWDisX bank_05.asm:431-437), so an $FF-only
 * stream there is a real room. The modes come from the loader's own CMP
 * immediates; these tests plant that check synthetically, so they need no ROM.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR, LEVEL_COUNT } from '../../../src/rom/SmwRom'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { readBossModes } from '../../../src/rom/LevelTableGate'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const CHECK_AT = 0x05b000 // not the vanilla address: the match is by shape
const LEVEL_PTR = 0x068000

/** bank_05.asm:431-442 as encoded: LDA $1925, three CMP/BEQ pairs, then the empty-stream check. */
function bossCheck(modes: [number, number, number], beq = [0x53, 0x4f, 0x4b]): number[] {
  return [
    0xad, 0x25, 0x19,
    0xc9, modes[0], 0xf0, beq[0],
    0xc9, modes[1], 0xf0, beq[1],
    0xc9, modes[2], 0xf0, beq[2],
    0xa0, 0x00, 0xb7, 0x65, 0xc9, 0xff,
  ] // prettier-ignore
}

function makeRom(opts: { check?: number[] | null; copies?: number } = {}): RomFile {
  const buf = Buffer.alloc(0x400000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('mock.smc', buf)
  const check = opts.check === undefined ? bossCheck([0x09, 0x0b, 0x10]) : opts.check
  if (check) for (let c = 0; c < (opts.copies ?? 1); c++) rom.writeAt(CHECK_AT + c * 0x100, check)
  rom.writeAt(ADDR.LEVEL_L1_PTR, [0x00, 0x80, 0x06])
  return rom
}

/** Slot 0's header with level mode `mode` and an $FF-only stream. */
function emptyStream(rom: RomFile, mode: number): SmwRom {
  rom.writeAt(LEVEL_PTR, [0x00, 0xe0 | mode, 0x00, 0x00, 0x00, 0xff])
  return new SmwRom(rom)
}

describe('levelHasObjects boss modes (#695)', () => {
  it.each([0x09, 0x0b, 0x10])('mode $%s with an $FF-only stream is a real room', mode => {
    expect(emptyStream(makeRom(), mode).levelHasObjects(0)).toBe(true)
  })

  it.each([0x00, 0x08, 0x0a, 0x0c, 0x0f, 0x11, 0x1f])(
    'mode $%s with an $FF-only stream is still empty',
    mode => {
      expect(emptyStream(makeRom(), mode).levelHasObjects(0)).toBe(false)
    },
  )

  it('a boss mode with a real first object stays true', () => {
    const rom = makeRom()
    rom.writeAt(LEVEL_PTR, [0, 0x09, 0, 0, 0, 0x42])
    expect(new SmwRom(rom).levelHasObjects(0)).toBe(true)
  })

  it('a header shorter than 6 bytes is still false in a boss mode', () => {
    const rom = makeRom()
    // Pointer into the last 5 bytes of the cart: the header fits, the stream does not.
    rom.writeAt(ADDR.LEVEL_L1_PTR, [0xfb, 0xff, 0xff])
    rom.buffer.set([0, 0x09, 0, 0, 0], 0x3ffffb)
    expect(new SmwRom(rom).levelHasObjects(0)).toBe(false)
  })

  it('reads the modes from the loader, not from the stock values', () => {
    const rom = makeRom({ check: bossCheck([0x08, 0x0a, 0x0c]) })
    expect(emptyStream(rom, 0x08).levelHasObjects(0)).toBe(true)
    expect(emptyStream(rom, 0x09).levelHasObjects(0)).toBe(false)
  })

  it('a loader that is absent gives no exemption: stock boss modes are not assumed', () => {
    const rom = makeRom({ check: null })
    expect(readBossModes(rom).ok).toBe(false)
    expect(emptyStream(rom, 0x09).levelHasObjects(0)).toBe(false)
  })

  it('a loader that appears twice is ambiguous: unavailable', () => {
    const rom = makeRom({ copies: 2 })
    const r = readBossModes(rom)
    expect(r.ok).toBe(false)
    expect(emptyStream(rom, 0x09).levelHasObjects(0)).toBe(false)
  })

  it('refuses a check that reads another RAM byte', () => {
    const check = bossCheck([0x09, 0x0b, 0x10])
    check[1] = 0x26
    expect(readBossModes(makeRom({ check })).ok).toBe(false)
  })

  it('refuses a check whose BEQs do not share a target', () => {
    const check = bossCheck([0x09, 0x0b, 0x10], [0x53, 0x4f, 0x10])
    expect(readBossModes(makeRom({ check })).ok).toBe(false)
  })

  it.each([
    ['LDA [Layer1DataPtr],Y direct page byte', 18, 0x66],
    ['the closing CMP immediate', 20, 0xfe],
  ])('refuses a check whose trailing anchor differs: %s', (_what, at, value) => {
    const check = bossCheck([0x09, 0x0b, 0x10])
    check[at] = value
    expect(readBossModes(makeRom({ check })).ok).toBe(false)
  })

  it('refuses a check whose BEQs all land on the empty-stream check (they DO read Layer 1)', () => {
    // Targets: 6+1+8, 10+1+4, 14+1+0 = 15, the LDY #0 itself.
    const check = bossCheck([0x09, 0x0b, 0x10], [0x08, 0x04, 0x00])
    expect(readBossModes(makeRom({ check })).ok).toBe(false)
  })

  it('accepts a common target exactly at the end of the check', () => {
    // 6+1+14, 10+1+10, 14+1+6 = 21
    const check = bossCheck([0x09, 0x0b, 0x10], [0x0e, 0x0a, 0x06])
    expect(readBossModes(makeRom({ check })).ok).toBe(true)
  })

  it('reads BEQ displacements as signed: a backward branch is not a far-forward one', () => {
    // As unsigned bytes the three targets agree (247); as signed they agree at -9,
    // before the check, so the check is refused.
    const check = bossCheck([0x09, 0x0b, 0x10], [0xf0, 0xec, 0xe8])
    expect(readBossModes(makeRom({ check })).ok).toBe(false)
  })

  it('refuses backward targets that agree only under sign extension', () => {
    // Signed: 7-14=-7, 11-18=-7, 15-22=-7. Unsigned bytes 0xf2/0xee/0xea give 249/245/241.
    const check = bossCheck([0x09, 0x0b, 0x10], [0xf2, 0xee, 0xea])
    expect(readBossModes(makeRom({ check })).ok).toBe(false)
  })

  it('re-reads after the ROM is edited', () => {
    const rom = makeRom()
    expect(readBossModes(rom).ok).toBe(true)
    rom.writeAt(CHECK_AT + 4, [0x08]) // first CMP immediate
    const r = readBossModes(rom)
    expect(r.ok && [...r.modes].sort((a, b) => a - b)).toEqual([0x08, 0x0b, 0x10])
  })
})

describe.skipIf(!hasRom(VANILLA))('levelHasObjects on the vanilla ROM (#695)', () => {
  it('accepts every real slot; the 24 that the $FF rule rejected are boss-mode rooms', () => {
    const smw = SmwRom.open(romPath(VANILLA))
    const cat = buildLevelCatalog(smw)
    const boss = readBossModes(smw.rom)
    expect(boss.ok && [...boss.modes].sort((a, b) => a - b)).toEqual([0x09, 0x0b, 0x10])

    let seen = 0
    const rejectedByStreamRule: number[] = []
    const rejectedNow: number[] = []
    for (let i = 0; i < LEVEL_COUNT; i++) {
      seen++
      if (!cat.entries[i]!.isReal) continue
      const raw = smw.getLevelRawData(i)!
      if (raw[5] === 0xff) rejectedByStreamRule.push(i)
      if (!smw.levelHasObjects(i)) rejectedNow.push(i)
    }
    expect(seen).toBe(512)
    expect(rejectedNow).toEqual([])
    expect(rejectedByStreamRule.length).toBe(24)
    expect(
      rejectedByStreamRule.every(
        i => boss.ok && boss.modes.has(smw.getLevelRawData(i)![1]! & 0x1f),
      ),
    ).toBe(true)
  })
})
