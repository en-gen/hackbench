/**
 * #842: GM12PrepLevel runs the Layer 3 handler (CODE_009FB8, bank_00.asm:4870) after the level
 * loads. For a tide level it sets ScreenMode bit 7 and the Layer 2/3 offset, which is what makes
 * a sprite read the tide as liquid (CODE_019140's second pass, bank_01.asm:2442-2489). The loader
 * omitted it, so the floating spike ball sank past the water the hardware sat in.
 */
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { unzip } from '../../../../tools/scripts/capture_render'
import { loaderShapeProblem, loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { CAPTURE_DIR, freshRom, hasCaptures, hasRom, VANILLA } from '../../support/corpus'
import { RomFile } from '../../../../src/rom/RomFile'
import { OP, word } from '../../support/asm65'
import { POINTER_TAIL } from '../../support/layer3Cart'
import { putLayer3 } from '../../support/syntheticLayer3'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

// A capture's first-frame WRAM (frame_0000_wram.bin), the hardware side of the comparisons below.
const frame0Wram = (map: string): Uint8Array => {
  const entries = unzip(readFileSync(join(CAPTURE_DIR, `${map}.zip`)))
  const key = [...entries.keys()].find(k => k.endsWith('frame_0000_wram.bin'))
  if (!key) throw new Error(`${map}: no frame_0000_wram.bin in the capture`)
  return new Uint8Array(entries.get(key)!())
}

describe('level loader runs the Layer 3 handler', () => {
  it('the synthetic cart stand-in ran: it sets ScreenMode bit 7 ($5B)', () => {
    const l = loadLevelState(buildSyntheticRom(), 0x105)
    expect(l.ok).toBe(true)
    expect(l.ok && l.wram[0x5b] & 0x80).toBe(0x80)
  })
  it('runs it after the data loader, which clears $5B', () => {
    // The stand-in data loader zeroes $5B (as the header loader rewrites ScreenMode); only a handler
    // that runs after it leaves bit 7 set.
    const l = loadLevelState(buildSyntheticRom({ irqCommand: 0 }), 0x105)
    expect(l.ok && l.wram[0x5b]).toBe(0x80)
  })
  it('skips it when IRQNMICommand bit 7 is set, as GM12PrepLevel does (boss rooms)', () => {
    // bank_00.asm:4861-4863: BPL runs the handler, a set bit 7 goes to CODE_0097BC instead.
    const l = loadLevelState(buildSyntheticRom({ irqCommand: 0x80 }), 0x105)
    expect(l.ok && l.wram[0x5b]).toBe(0)
    const kept = loadLevelState(buildSyntheticRom({ irqCommand: 0x7f }), 0x105)
    expect(kept.ok && kept.wram[0x5b]).toBe(0x80)
  })
  it('runs the Layer 3 reset before the handler, and skips both when bit 7 is set', () => {
    // The stand-in at $05:BE8A copies $1C to $24 (CODE_05BE8A, bank_05.asm:4794-4795); the bare handler
    // stand-in stores $40 in $24. The pointer loader's tail stands $5A in $1C and the IRQNMICommand it wants.
    const cart = (irq: number, tableHandler = false) => {
      const rom = buildSyntheticRom()
      rom.writeAt(POINTER_TAIL, [OP.LDA_IMM, 0x5a, OP.STA_DP, 0x1c, OP.LDA_IMM, irq, OP.STA_ABS, ...word(0x0d9b), OP.PLB, OP.RTL]) // prettier-ignore
      if (tableHandler) putLayer3((at, bytes) => rom.writeAt(at, bytes)) // leaves $24 alone: Layer 3 setting 0
      return rom
    }
    const at24 = (r: ReturnType<typeof loadLevelState>) => r.ok && [r.wram[0x24], r.wram[0x25]]
    // Order: the handler's $40 is the last write. Reset after the handler would leave the $5A it copies.
    expect(at24(loadLevelState(cart(0), 0x105))).toEqual([0x40, 0])
    // The reset on its own: a handler that writes nothing to $24 leaves what the reset copied.
    expect(at24(loadLevelState(cart(0, true), 0x105))).toEqual([0x5a, 0])
    // Bit 7 set skips both calls.
    expect(at24(loadLevelState(cart(0x80), 0x105))).toEqual([0, 0])
    expect(at24(loadLevelState(cart(0x80, true), 0x105))).toEqual([0, 0])
  })
  it('refuses a ROM whose Layer 3 reset is not the vanilla shape', () => {
    const l = loadLevelState(buildSyntheticRom({ badLoader: 'reset' }), 0x105)
    expect(l).toMatchObject({ ok: false, reason: expect.stringMatching(/Layer 3 reset/) })
  })
  it('refuses a ROM whose Layer 3 handler is not the vanilla shape', () => {
    const l = loadLevelState(buildSyntheticRom({ badLoader: 'layer3' }), 0x105)
    expect(l).toMatchObject({ ok: false, reason: expect.stringMatching(/Layer 3 handler/) })
  })
  it('refuses a ROM whose GM12PrepLevel call site is not the vanilla shape', () => {
    // The call site (bank_00.asm:4861-4870) holds the IRQNMICommand bit 7 test the loader mirrors.
    const l = loadLevelState(buildSyntheticRom({ badLoader: 'gm12' }), 0x105)
    expect(l).toMatchObject({ ok: false, reason: expect.stringMatching(/GM12PrepLevel/) })
  })
  // Each byte below is in the call site's fingerprint, not just the first one: masking it lets the plant through.
  it.each([
    ['the byte at $00:A5B2 (the BPL on IRQNMICommand bit 7 in the game)', 0x00a5b2, 0x30],
    ['the byte at $00:A5C4 (the handler JSR target in the game)', 0x00a5c4, 0xb9],
  ])('refuses a GM12PrepLevel call site with %s changed', (_n, at, v) => {
    const rom = buildSyntheticRom()
    rom.writeAt(at, [v])
    expect(loadLevelState(rom, 0x105)).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/GM12PrepLevel call site/),
    })
  })
})

// Map $102 is a tide level (hardware $5B = $80, Layer3YPos = $40). Its $A4 at 912,400 sat at the list
// y on hardware (anchor y 399, one capture, Mesen 2.x); the water tile starts below the level.
describe.skipIf(!hasRom(VANILLA))('vanilla map $102 floating spike ball', () => {
  it('the loaded image has the tide interaction layer on', () => {
    const l = loadLevelState(freshRom(), 0x102)
    expect(l.ok && l.wram[0x5b] & 0x80).toBe(0x80)
  })
  // All nine $A4 records of map $102 (the sprite list, one capture each), not only the first.
  it.each([
    [912, 400],
    [1104, 368],
    [1808, 400],
    [1888, 368],
    [2128, 400],
    [2224, 368],
    [2320, 400],
    [2448, 400],
    [2544, 400],
  ])('INIT leaves $A4 at %i,%i within 16 px of its list y', (x, y) => {
    const l = loadLevelState(freshRom(), 0x102)
    if (!l.ok) throw new Error(l.reason)
    const m = runSprite(
      freshRom(),
      0xa4,
      withSeed({ loaded: l.wram, sprite: { x, y }, mainPasses: 1 }),
    )
    expect(Math.abs(m.anchor!.y - y)).toBeLessThanOrEqual(16)
  })
})

// Every tide map in the level-load capture set: the capture's own $5B bit 7 is set (so the comparison
// is not 0 = 0) and the loader's $5B, $24 (Layer3YPos low, rammap.asm:184) and $28 (Layer 3 Y offset low) equal the capture's
// at its first frame. $26/$27 are not asserted: they come from the camera (CODE_05BC4A, bank_05.asm:4491-4512)
// and the runner seeds another one, so maps 0be and 0c1 differ there (docs/sprites/sprite-a4-floating-spike-ball.md).
describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'tide maps vs the level-load captures (#842)',
  () => {
    it.each(['002', '0be', '0c1', '102', '127'])('map %s', map => {
      const hw = frame0Wram(map)
      const l = loadLevelState(freshRom(), parseInt(map, 16))
      if (!l.ok) throw new Error(l.reason)
      expect(hw[0x5b] & 0x80).toBe(0x80)
      expect(l.wram[0x5b] & 0x80).toBe(0x80)
      expect(l.wram[0x24]).toBe(hw[0x24])
      expect(l.wram[0x28]).toBe(hw[0x28])
    })
  },
)

// Layer3YPos ($24/$25) where CODE_009FB8 writes nothing: modes $81-$BF on a tileset other than Castle1 and
// Underground1 (bank_00.asm:4166-4174, 4199), which is maps 011, 130 and 1c1. Only the CODE_05BE8A step before
// it (bank_00.asm:4869; Layer3YPos = Layer1YPos, bank_05.asm:4794-4795) sets it, so these maps read the
// loader's step. Hardware holds $00C0 (frame_0000, one capture each).
describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'Layer3YPos on maps the handler leaves alone vs the level-load captures (#842)',
  () => {
    it.each(['011', '130', '1c1'])('map %s', map => {
      const hw = frame0Wram(map)
      const l = loadLevelState(freshRom(), parseInt(map, 16))
      if (!l.ok) throw new Error(l.reason)
      expect(hw[0x24] | (hw[0x25] << 8)).toBe(0xc0)
      expect(l.wram[0x24] | (l.wram[0x25] << 8)).toBe(0xc0)
    })
  },
)

// The IRQNMICommand bit 7 gate against hardware, by mode (SpecialLevTable, bank_05.asm:500-503): every
// captured vanilla level that ends with the bit set (modes 9, $B, $10). $13D5 is the loader's result
// of skipping or running the handler; it must equal the capture's first frame (one capture each).
describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'bit-7 maps vs the level-load captures (#842)',
  () => {
    it.each([
      '095',
      '096',
      '097',
      '098',
      '099',
      '09a',
      '09b',
      '0cc',
      '0d5',
      '0d9',
      '195',
      '196',
      '197',
      '198',
      '199',
      '19a',
      '19b',
      '1c7',
    ])('map %s', map => {
      const hw = frame0Wram(map)
      const l = loadLevelState(freshRom(), parseInt(map, 16))
      if (!l.ok) throw new Error(l.reason)
      expect(hw[0x0d9b] & 0x80).toBe(0x80)
      expect(l.wram[0x0d9b] & 0x80).toBe(0x80)
      expect(l.wram[0x13d5]).toBe(hw[0x13d5])
    })
  },
)

// The fingerprinted spans of the loader: every unmasked byte is in the hash (a change is refused by name) and
// every masked byte is not (a change is accepted). The masks are spelled here on purpose: an empty mask, or one
// that covers too much, fails one half. Synthetic, then the same sweep on the vanilla ROM.
const SPAN_SWEEP = [
  { name: /^pointer loader at \$05:D8B7/, at: 0x05d8b7, length: 9, masked: [] as number[] },
  { name: /^level data loader at \$05:801E/, at: 0x05801e, length: 12, masked: [] as number[] },
  {
    name: /^Layer 3 reset at \$05:BE8A/,
    at: 0x05be8a,
    length: 28,
    masked: [6, 7, 9, 10, 12, 13, 15, 16, 18, 19],
  },
  {
    name: /^GM12PrepLevel call site/,
    at: 0x00a5af,
    length: 23,
    masked: [11, 12, 14, 15, 17, 18, 19],
  },
]
const sweep = (make: () => ReturnType<typeof buildSyntheticRom>) => {
  for (const span of SPAN_SWEEP)
    for (let i = 0; i < span.length; i++) {
      const rom = make()
      rom.writeAt(span.at + i, [rom.readAt(span.at + i, 1)[0] ^ 0x55])
      const problem = loaderShapeProblem(rom)
      if (span.masked.includes(i)) expect(problem, `${span.at.toString(16)}+${i}`).toBeNull()
      else expect(problem, `${span.at.toString(16)}+${i}`).toMatch(span.name)
    }
}
describe('fingerprinted spans: unmasked offsets are refused, masked ones are not', () => {
  it('on the synthetic cart', () => sweep(() => buildSyntheticRom()))
  it('the unchanged synthetic cart is accepted, and only the instance that was vouched for', () => {
    expect(loaderShapeProblem(buildSyntheticRom())).toBeNull()
    const src = buildSyntheticRom()
    const bytes = Uint8Array.from(
      [0, 1, 2, 3, 4, 5, 6, 7].flatMap(b => Array.from(src.readAt((b << 16) | 0x8000, 0x8000))),
    )
    const copy = RomFile.fromBytes('copy.sfc', bytes)
    expect(loaderShapeProblem(copy)).toMatch(/is not the vanilla shape/)
  })
})
describe.skipIf(!hasRom(VANILLA))('fingerprinted spans on the vanilla ROM', () => {
  it('the unchanged ROM is accepted', () => expect(loaderShapeProblem(freshRom())).toBeNull())
  it('every unmasked offset is refused, every masked one accepted', () => sweep(() => freshRom()))
})
