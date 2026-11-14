/**
 * #1231: at rest, every sprite is drawn where its INIT leaves it, with its stored spot kept as data and reported
 * (`stored`) so the map can outline the tile. Synthetic cart, no ROM bytes (D126/D127). Replaces D134's re-base
 * onto the placed spot (docs/decisions/2026-11-14-sprites-draw-where-their-code-puts-them.md).
 */
import { describe, it, expect } from 'vitest'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { modelResult } from '../../../../theia/extension/src/node/map-sprites'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

type Ok = { ok: true; anchor: { x: number; y: number }; stored?: { x: number; y: number } }
const served = (m: ReturnType<typeof runOnce>) => modelResult(m) as unknown as Ok

describe('at rest, a sprite is drawn where its INIT leaves it (#1231)', () => {
  const rom = buildSyntheticRom()

  it('INIT moves it (+8, -1): drawn at that offset from its stored tile, and the stored tile is reported', () => {
    const m = runOnce(rom, 1, SPRITE_SEED, { atRest: true })
    expect(m.refusal).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x88, y: 0x7f, rawX: 0x80, rawY: 0x80 })
    expect(m.shifted).toBe(true)
    expect(m.initAt).toEqual({ x: 0x88, y: 0x7f })
    expect(m.passes[m.chosen!]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
    expect(served(m)).toMatchObject({
      ok: true,
      anchor: { x: 0x88, y: 0x7f },
      stored: { x: 0x80, y: 0x80 },
    })
  })

  it('INIT does not move it: drawn on its tile, nothing reported as stored', () => {
    const m = runOnce(rom, 2, SPRITE_SEED, { atRest: true })
    expect(m.anchor).toMatchObject({ x: 0x80, y: 0x80, rawX: 0x80, rawY: 0x80 })
    expect(m.shifted).toBeUndefined()
    expect(served(m).stored).toBeUndefined()
  })

  it("follows the seed: the offset is INIT's, whatever the tile", () => {
    const m = runOnce(rom, 1, withSeed({ sprite: { x: 0x140, y: 0x90 } }), { atRest: true })
    expect(m.anchor).toMatchObject({ x: 0x148, y: 0x8f, rawX: 0x140, rawY: 0x90 })
  })

  it('the offset is what INIT adds, not a constant: id 0 with initShift 20 moves 20', () => {
    const m = runOnce(buildSyntheticRom({ initShift: 20 }), 0, SPRITE_SEED, { atRest: true })
    expect(m.anchor).toMatchObject({ x: 0x80 + 20, y: 0x80, rawX: 0x80 })
  })

  // More than a quarter screen, as InitBrwnChainPlat does (+$78, +$68; SMWDisX bank_01.asm:9705-9718).
  it('an INIT that moves it +120, +104 draws at that offset from its stored tile', () => {
    const big = buildSyntheticRom({ initDelta: [120, 104] })
    const m = runOnce(big, 0, SPRITE_SEED, { atRest: true })
    expect(m.refusal).toBeUndefined()
    expect(m.emptyReason).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x80 + 120, y: 0x80 + 104, rawX: 0x80, rawY: 0x80 })
    expect(m.shifted).toBe(true)
    expect(m.passes[m.chosen!]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
    expect(served(m)).toMatchObject({ anchor: { x: 0xf8, y: 0xe8 }, stored: { x: 0x80, y: 0x80 } })
  })

  it('a negative move (-320, -16) stands on the signed spot', () => {
    const m = runOnce(buildSyntheticRom({ initDelta: [-320, -16] }), 0, withSeed({ sprite: { x: 0x200, y: 0x80 } }), { atRest: true }) // prettier-ignore
    expect(m.anchor).toMatchObject({ x: 0x200 - 320, y: 0x70, rawX: 0x200, rawY: 0x80 })
  })

  it('the not-at-rest run (graders, play) is unchanged: INIT first, its moves kept', () => {
    const m = runOnce(rom, 1, SPRITE_SEED)
    expect(m.anchor).toMatchObject({ x: 0x88, y: 0x7f, rawX: 0x80, rawY: 0x80 })
    expect(m.shifted).toBeUndefined()
  })
})
