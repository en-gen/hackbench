/**
 * #1231 review: "never appears in play" needs positive evidence. On a vertical map the loader spawns a sprite 288 px
 * below or 48 px above the camera (DATA_02A7F6, SMWDisX bank_02.asm:5217-5238), outside GetDrawInfo's vertical window,
 * so a sprite that is merely culled there draws nothing; that is no evidence it is behind the scroll. Synthetic cart (no ROM).
 */
import { describe, expect, it } from 'vitest'
import { fingerprint } from '../../../../src/rom/Fingerprint'
import { runOnce, startsBehind } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom, type SyntheticOptions } from '../../support/syntheticSpriteRom'

const TABLES = 0x02a7f6
const word = (v: number) => [v & 255, 0, (v >> 8) & 255]
const POS = 0x1090

/** startsBehind for `id` at POS on a map of `screenMode` with the loader window `left` (up) and `right` (down). */
function behind(
  id: number,
  o: SyntheticOptions,
  screenMode: number,
  left: number,
  right: number,
): boolean | undefined {
  // prettier-ignore
  const rom = buildSyntheticRom(o)
  const [l, r] = [word(left), word(right)]
  rom.writeAt(TABLES, [l[0]!, 0, r[0]!, l[2]!, 0, r[2]!])
  const loader = { at: TABLES, len: 6, sha: fingerprint(rom.readAt(TABLES, 6))! }
  const seed = withSeed({ slot: 3, sprite: { x: POS, y: POS }, level: { screenMode, screens: 32 } }, SPRITE_SEED) // prettier-ignore
  return startsBehind(rom, id, seed, { loader }, { x: POS, y: POS })
}

describe('never appears needs positive evidence', () => {
  // Id 1: INIT moves it (+8, -1), MAIN draws one piece, static. cullVertical: drawn only 0-255 px below the camera.
  it('a static INIT-moved sprite the vertical window culls in the spawn is not "never appears" (the find)', () => {
    expect(behind(1, { cullVertical: true }, 1, -48, 288)).toBe(false)
  })

  it('and the run really drew nothing there, so the old reading of an empty run as "behind" was the cause', () => {
    const rom = buildSyntheticRom({ cullVertical: true })
    const m = runOnce(rom, 1, withSeed({ camera: { y: POS - 288 }, level: { screenMode: 1, screens: 32 }, sprite: { x: POS, y: POS } }, SPRITE_SEED), {}) // prettier-ignore
    expect(m.passes.every(p => p.parts.length === 0)).toBe(true)
    expect(m.emptyReason).toBeDefined()
  })

  // Id 0: INIT moves it 264 px ahead (past the offscreen keep range) and survives; MAIN, as the offscreen handler does
  // (SubOffscreen0Bnk1, bank_01.asm:5975-6043), erases it (status 0) without drawing. That is the evidence: it never appears.
  it('a sprite INIT moves ahead and MAIN erases without drawing never appears (the per-pass erase)', () => {
    const FAR = -0x2000 // a left window whose camera lies past the map's end: only the scroll-right spawn runs
    expect(behind(0, { initFarCull: true, eraseFar: true }, 0, FAR, 0x20)).toBe(true)
  })

  it('the same sprite culled but not erased is no evidence: it drifts into view', () => {
    const FAR = -0x2000
    expect(behind(0, { initFarCull: true }, 0, FAR, 0x20)).toBe(false)
  })

  it('control: a sprite whose INIT erases it (id 8, status 0) is positive evidence: never appears', () => {
    expect(behind(8, {}, 0, -48, 288)).toBe(true)
  })
})
