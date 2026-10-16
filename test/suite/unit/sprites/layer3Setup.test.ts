/**
 * #842: GM12PrepLevel runs the Layer 3 handler (CODE_009FB8, bank_00.asm:4870) after the level
 * loads. For a tide level it sets ScreenMode bit 7 and the Layer 2/3 offset, which is what makes
 * a sprite read the tide as liquid (CODE_019140's second pass, bank_01.asm:2442-2489). The loader
 * omitted it, so the floating spike ball sank past the water the hardware sat in.
 */
import { describe, expect, it } from 'vitest'
import { loadLevelState } from '../../../../src/rom/sprites/interp/LevelLoader'
import { runSprite } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { freshRom, hasRom, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

describe('level loader runs the Layer 3 handler', () => {
  it('the synthetic cart stand-in ran: it sets ScreenMode bit 7 ($5B)', () => {
    const l = loadLevelState(buildSyntheticRom(), 0x105)
    expect(l.ok).toBe(true)
    expect(l.ok && l.wram[0x5b] & 0x80).toBe(0x80)
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
  it('INIT leaves $A4 within 16 px of its list y', () => {
    const l = loadLevelState(freshRom(), 0x102)
    if (!l.ok) throw new Error(l.reason)
    const m = runSprite(
      freshRom(),
      0xa4,
      withSeed({ loaded: l.wram, sprite: { x: 912, y: 400 }, mainPasses: 1 }),
    )
    expect(Math.abs(m.anchor!.y - 400)).toBeLessThanOrEqual(16)
  })
})
