/**
 * A sprite whose draw routine returns before drawing unless its own timer runs, and that nothing at rest arms (#1002: the
 * climbing net door, SMWDisX bank_01.asm:8026-8057 - the punch arms the timer, the game draws nothing before). The map view
 * shows the quiet marker at its placed spot, not the failure box. Synthetic cart (syntheticRevealSprites.ts id 176), so CI
 * needs no ROM; the vanilla doors are in TimerGatedSprite.corpus.test.ts.
 *
 * The loader's id routing is stubbed readable: the synthetic cart has no level loader call, and an empty run on an unread
 * routing keeps the box by design (#1011), which would hide the verdict under test.
 */
import { describe, expect, it, vi } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { withSeed, SPRITE_SEED } from '../../../src/rom/sprites/interp/SpriteSeed'
import {
  drawSprites,
  interpDrawer,
  modelResult,
  runWithUploads,
} from '../../../theia/extension/src/node/map-sprites'
import { buildSyntheticRom } from '../support/syntheticSpriteRom'
import { COLORS } from '../support/mapInputs'
import { sharedPixels } from '../support/spritePixels'

vi.mock('../../../src/rom/sprites/interp/LoadClass', async importOriginal => ({
  ...(await importOriginal<typeof import('../../../src/rom/sprites/interp/LoadClass')>()),
  loadClasses: () => ({ status: 'ok', of: () => 'normal' }),
}))

const TIMER_GATED = 176
const rom = buildSyntheticRom()
const geometry = { isVertical: false, screenCount: 0x20 }
/** Screen $10, tile column 256, row $12: the sprite stands at (0x1000, 0x120). */
const entry = (spriteId: number): LevelSprite =>
  ({ screen: 0x10, x: 0x100, y: 0x12, spriteId, extraBit: false, raw: [0, 0, 0], index: 0, streamOffset: 0 }) as LevelSprite // prettier-ignore
const base = () => {
  const loaded = new Uint8Array(0x20000)
  loaded.set([0x80, 0, 0x20, 1], 0x94)
  return withSeed({}, { ...SPRITE_SEED, loaded })
}
const drawer = () => interpDrawer(rom, 0x105, geometry, runWithUploads, base)
const served = (id: number) =>
  drawSprites([entry(id)], { vram: {} as never, colors: COLORS }, drawer())[0]!
const alpha = (rgba: string) => {
  const b = Buffer.from(rgba, 'base64')
  return (x: number, y: number) => b[(y * 16 + x) * 4 + 3]!
}

describe('a sprite that draws only while its own timer runs (#1002)', () => {
  it('draws nothing at rest or under any search condition, and the drawer says so as a verified empty run', () => {
    const r = drawer()(entry(TIMER_GATED))
    expect(r).toMatchObject({ ok: false, reason: 'unrevealed', empty: true })
    expect('unverified' in r).toBe(false)
  })

  it('is the quiet ring at its placed spot, not the failure box', () => {
    const d = served(TIMER_GATED)
    expect(d).toMatchObject({
      status: 'quiet',
      reason: 'unrevealed',
      x: 0x1000,
      y: 0x120,
      box: { x0: 0x1000, y0: 0x120, x1: 0x1010, y1: 0x130 },
    })
    const a = alpha(d.rgba)
    // Ring and centre dot opaque, interior and corners clear so the tile under it shows.
    expect([a(7, 1), a(1, 7), a(8, 14), a(7, 7)]).toEqual([255, 255, 255, 255])
    expect([a(0, 0), a(15, 15), a(4, 4), a(11, 4), a(4, 11)]).toEqual([0, 0, 0, 0, 0])
    expect(Array.from(Buffer.from(d.priority!, 'base64')).every(p => p === 3)).toBe(true)
  })

  it('is the timer that gates it: the same sprite draws once its timer is nonzero', () => {
    // Every slot's $1540 set, so the check does not depend on which slot the run uses.
    const ram = Object.fromEntries(Array.from({ length: 12 }, (_, i) => [0x1540 + i, 0x1f]))
    const seed = withSeed({ sprite: { x: 0x1000, y: 0x120 }, camera: { x: 0xf80, y: 0xb0 }, ram }, base()) // prettier-ignore
    const armed = modelResult(runWithUploads(rom, TIMER_GATED, seed))
    expect(armed.ok, JSON.stringify(armed)).toBe(true)
    const rest = modelResult(runWithUploads(rom, TIMER_GATED, withSeed({ sprite: { x: 0x1000, y: 0x120 }, camera: { x: 0xf80, y: 0xb0 } }, base()))) // prettier-ignore
    expect(rest.ok).toBe(false)
  })
})

describe('the pixel-overlap check the corpus test uses can fail (#1002)', () => {
  const ring = served(TIMER_GATED)
  it('sees a sprite planted on the ring, and not one a tile away', () => {
    expect(sharedPixels(ring, ring).length).toBeGreaterThan(20)
    const at = (dx: number) => ({ ...ring, box: { ...ring.box, x0: ring.box.x0 + dx, x1: ring.box.x1 + dx } }) // prettier-ignore
    expect(sharedPixels(ring, at(1)).length).toBeGreaterThan(0)
    expect(sharedPixels(ring, at(16))).toEqual([])
  })
})
