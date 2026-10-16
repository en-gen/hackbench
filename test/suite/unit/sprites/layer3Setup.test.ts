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
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { CAPTURE_DIR, freshRom, hasCaptures, hasRom, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

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
  it('refuses a ROM whose Layer 3 handler is not the vanilla shape', () => {
    const l = loadLevelState(buildSyntheticRom({ badLoader: 'layer3' }), 0x105)
    expect(l).toMatchObject({ ok: false, reason: expect.stringMatching(/Layer 3 handler/) })
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
// is not 0 = 0) and the loader's $5B, $24 (Layer3XPos low) and $28 (Layer 3 Y offset low) equal the capture's
// at its first frame. $26/$27 are not asserted: they come from the camera (CODE_05BC4A, bank_05.asm:4491-4512)
// and the runner seeds another one, so maps 0be and 0c1 differ there (docs/sprites/sprite-a4-floating-spike-ball.md).
describe.skipIf(!hasCaptures() || !hasRom(VANILLA))(
  'tide maps vs the level-load captures (#842)',
  () => {
    const frame0Wram = (map: string): Uint8Array => {
      const entries = unzip(readFileSync(join(CAPTURE_DIR, `${map}.zip`)))
      const key = [...entries.keys()].find(k => k.endsWith('frame_0000_wram.bin'))
      if (!key) throw new Error(`${map}: no frame_0000_wram.bin in the capture`)
      return new Uint8Array(entries.get(key)!())
    }
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
