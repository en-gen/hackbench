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

// The Layer 3 sites are single instructions (loaderSites), swept like the others in levelLoaderFingerprint.test.ts;
// these name the ones the bit 7 mirror depends on. No corpus needed.
describe('GM12PrepLevel call site: each instruction the loader mirrors is checked', () => {
  it.each([
    ['the BPL opcode at $00:A5B2 (skip polarity)', 0x00a5b2, 0x30],
    ['the BPL distance at $00:A5B3 (it must land on the JSR)', 0x00a5b3, 0x06],
    ['the LDA operand at $00:A5B0 (IRQNMICommand)', 0x00a5b0, 0x9c],
    ['the JSL opcode at $00:A5BF', 0x00a5bf, 0x20],
    ['the JSR opcode at $00:A5C3', 0x00a5c3, 0x22],
    ['the JSR target low byte at $00:A5C4 (the handler)', 0x00a5c4, 0xb9],
    ['the JSR target high byte at $00:A5C5 (the handler)', 0x00a5c5, 0x9e],
  ])('refuses %s changed, by name', (_n, at, v) => {
    const rom = buildSyntheticRom()
    expect(loaderShapeProblem(rom)).toBeNull()
    rom.writeAt(at, [v])
    expect(loaderShapeProblem(rom)).toBe(
      'GM12PrepLevel call site of the Layer 3 handler at $00:A5AF is not the vanilla shape; the loader will not run it',
    )
    expect(loadLevelState(rom, 0x105)).toMatchObject({ ok: false })
  })
  it.each(['gm12Bpl', 'gm12Jsr'] as const)('the %s cart option is refused by name', k => {
    const l = loadLevelState(buildSyntheticRom({ badLoader: k }), 0x105)
    expect(l).toMatchObject({ ok: false, reason: expect.stringMatching(/GM12PrepLevel call site/) })
  })
  it('the reset call target is not compared (hacked ROMs hook it), the reset opcode is checked by name', () => {
    const rom = buildSyntheticRom()
    rom.writeAt(0x00a5c2, [0x0e])
    expect(loaderShapeProblem(rom)).toBeNull()
    const bare = buildSyntheticRom()
    bare.writeAt(0x05be8a, [0xea])
    expect(loaderShapeProblem(bare)).toMatch(/^Layer 3 reset at \$05:BE8A/)
  })
})
describe.skipIf(!hasRom(VANILLA))('Layer 3 sites on the vanilla ROM', () => {
  it('the unchanged ROM is accepted', () => expect(loaderShapeProblem(freshRom())).toBeNull())
})
