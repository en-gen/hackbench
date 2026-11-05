/**
 * Hidden sprites on the map (#1132), served path: `interpDrawer` runs the reveal search for the map view's runs, and
 * `drawSprites` / `compositeSpriteScreen` / `spriteName` carry the result to the screen door and the hover. Synthetic
 * cart (syntheticRevealSprites.ts), so CI needs no ROM.
 */
import { describe, expect, it } from 'vitest'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { runOnce } from '../../../src/rom/sprites/interp/SpriteRunner'
import { withSeed, SPRITE_SEED, type SpriteSeed } from '../../../src/rom/sprites/interp/SpriteSeed'
import {
  drawSprites,
  interpDrawer,
  modelResult,
  runWithUploads,
  type SpriteDrawResult,
} from '../../../theia/extension/src/node/map-sprites'
import { composeScreen } from '../../../src/rom/model/ColorMath'
import {
  doorIdAt,
  liftIfCovered,
  spriteDoors,
  spriteName,
  spritePlanes,
} from '../../../theia/extension/src/browser/map-view-model'
import { notDrawnText } from '../../../theia/extension/src/browser/sprite-props'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import { buildSyntheticRom } from '../support/syntheticSpriteRom'
import { COLORS } from '../support/mapInputs'

const rom = buildSyntheticRom()
const model = { isVertical: false, screenCount: 0x20 }
/** Screen $10, tile column 256, row $12: the sprite stands at (0x1000, 0x120). */
const entry = (spriteId: number): LevelSprite =>
  ({ screen: 0x10, x: 0x100, y: 0x12, spriteId, extraBit: false, raw: [0, 0, 0], index: 0, streamOffset: 0 }) as LevelSprite // prettier-ignore

/** A loaded level image with Mario at x = 0x80 (his $94), the camera on the sprite. */
const base = (marioX = 0x80): SpriteSeed => {
  const loaded = new Uint8Array(0x20000)
  loaded.set([marioX & 0xff, marioX >> 8, 0x20, 1], 0x94)
  return withSeed({}, { ...SPRITE_SEED, loaded })
}
const drawer = (run = runWithUploads, marioX = 0x80) => interpDrawer(rom, 0x105, model, run, () => base(marioX)) // prettier-ignore
const ok = (r: SpriteDrawResult) => {
  if (!r.ok) throw new Error(`not drawn: ${JSON.stringify(r)}`)
  return r
}

describe('the served drawer reveals hidden sprites', () => {
  it('draws a touch sprite where it is placed and says what showed it', () => {
    const r = ok(drawer()(entry(140)))
    expect(r.reveal).toBe('mario-at-sprite')
    expect(r.anchor).toEqual({ x: 0x1000, y: 0x120 })
  })

  it('leaves a sprite that draws at rest alone', () => {
    expect(ok(drawer()(entry(0)))).not.toHaveProperty('reveal')
  })

  it('marks a sprite no condition shows, with its own reason code', () => {
    expect(drawer()(entry(5))).toMatchObject({ ok: false, reason: 'unrevealed' })
  })

  it('keeps the real-start picture in the door when it drew, hides under a probe, and nothing reveals it (id 56)', () => {
    // Mario starts $40 px right of the sprite, the only place it draws.
    const r = ok(drawer(runWithUploads, 0x1040)(entry(156)))
    expect(r.reveal).toBe('none-found')
    expect(r.anchor).toEqual({ x: 0x1000, y: 0x120 })
    // A start elsewhere never draws it: still a marker with its reason.
    expect(drawer()(entry(156))).toMatchObject({ ok: false, reason: 'unrevealed' })
  })

  it('searches only the map view runs: a custom run (the block spawn) keeps the old answer', () => {
    const plain = drawer((r, id, seed) => runOnce(r, id, seed, { atRest: true }))(entry(140))
    expect(plain).toMatchObject({ ok: false })
    expect((plain as { reason: string }).reason).not.toBe('unrevealed')
  })

  it('keeps the marker of a refused sprite, with no search', () => {
    // Id 4 executes COP.
    expect(drawer()(entry(4))).toMatchObject({
      ok: false,
      reason: expect.stringMatching(/^refused/),
    })
  })

  it('takes the position from the same model the at-rest path gives, even when it moved before it drew', () => {
    // Id 49 rises every pass and draws from frame 3. Rebuild the revealing seed the way the search does.
    const got = ok(drawer()(entry(149)))
    const seed = withSeed(
      {
        sprite: { x: 0x1000, y: 0x120 },
        marioMain: { x: 0x1000, y: 0x120 },
        ram: { 0x19: 0, 0x72: 0, 0x187a: 0 },
      },
      withSeed(
        {
          camera: { x: 0xf80, y: 0xb0 },
          mario: { x: 0x80, y: 0x120 },
          level: { screenMode: 0, screens: 0x20 },
        },
        base(),
      ),
    )
    const m = runWithUploads(rom, 149, seed)
    expect(m.chosen).toBeGreaterThan(0)
    const want = ok(modelResult(m))
    expect(got.anchor).toEqual(want.anchor)
    expect(got.parts).toEqual(want.parts)
  })
})

describe('the picture and its hover', () => {
  const part = { charNum: 0x400, palette: 9, flipX: false, flipY: false, dx: 0, dy: 0 }
  const SP1 = [new Uint8Array(64).fill(3)]
  const m = { vram: { sp1: SP1 }, colors: COLORS }
  const spr = { index: 0, x: 0, y: 0, spriteId: 0xc7, screen: 0, extraBit: false, raw: [], streamOffset: 0 } as unknown as LevelSprite // prettier-ignore
  const ident = { spriteId: 0xc7, mainHandler: 0, initHandler: 0, status: 'vanilla' } as const
  const shown = (reveal?: 'mario-at-sprite' | 'p-switch') =>
    drawSprites([spr], m, () => ({ ok: true, parts: [{ ...part, dx: 0 }, { ...part, dx: 8 }], identity: ident, ...(reveal ? { reveal } : {}) }) as SpriteDrawResult)[0]! // prettier-ignore

  it('sets the whole-sprite door and the hover text only for a revealed sprite', () => {
    expect(shown()).not.toHaveProperty('screenDoor')
    expect(shown('mario-at-sprite')).toMatchObject({ screenDoor: true, reveal: expect.stringContaining('Mario gets close to this spot') }) // prettier-ignore
  })

  it('states Mario fixed state in every condition, and never a sprite id', () => {
    for (const c of ['mario-at-sprite', 'p-switch'] as const) {
      expect(shown(c).reveal).toContain('small Mario, on foot')
      expect(shown(c).reveal).not.toMatch(/\$|C7|0x/i)
    }
  })

  it('claims no condition for a sprite nothing reveals, and no Mario state', () => {
    const d = drawSprites([spr], m, () => ({ ok: true, parts: [part], identity: ident, reveal: 'none-found' }) as SpriteDrawResult)[0]! // prettier-ignore
    expect(d).toMatchObject({ screenDoor: true, reveal: 'is not always there, and the app could not tell what hides it' }) // prettier-ignore
    expect(d.reveal).not.toMatch(/appears|Mario/)
  })

  it('names the sprite from the app name table, then the condition', () => {
    const d = { ...shown('mario-at-sprite'), name: 'Invisible mushroom' }
    expect(spriteName(d)).toBe(
      'Invisible mushroom: appears when Mario gets close to this spot (small Mario, on foot)',
    )
    expect(spriteName({ id: 0x33, name: 'Podoboo' })).toBe('Podoboo')
  })

  describe('the whole-sprite door goes through the door map and composeScreen', () => {
    const geometry = { orientation: 'horizontal' as const, width: 256, height: 224 }
    /** The alpha of the sprite's 16 x 8 pixels as composeScreen gives them, optionally with the sprite lifted. */
    const alphas = (d: MapSpriteDto, lifted = false) => {
      const doors = spriteDoors({ ...geometry, sprites: [d] }, 0)!
      const planes = spritePlanes({ ...geometry, sprites: [d] }, 0)
      const id = doorIdAt(doors, 256, 0, 0)
      const px = composeScreen({ width: 256, height: 224, planes, lists: { main: ['sprites2'], sub: [] }, math: null, doors, lift: lifted ? id : undefined }) // prettier-ignore
      const out: number[] = []
      for (let y = 0; y < 8; y++) for (let x = 0; x < 16; x++) out.push(px[(y * 256 + x) * 4 + 3]!)
      return { out, id }
    }

    it('draws a plain sprite solid and a revealed one on alternating squares, none clear', () => {
      expect(new Set(alphas(shown()).out)).toEqual(new Set([255]))
      const { out } = alphas(shown('mario-at-sprite'))
      expect(new Set(out).size).toBe(2)
      expect(out[0]).not.toBe(out[1])
      expect(Math.min(...out)).toBeGreaterThan(0)
    })

    it('lifts the hovered revealed sprite to solid (#879), which a baked alpha could not', () => {
      expect(new Set(alphas(shown('mario-at-sprite'), true).out)).toEqual(new Set([255]))
    })

    it('lifts a whole-door sprite wherever it is, with no tile over it', () => {
      const { id } = alphas(shown('mario-at-sprite'))
      expect(liftIfCovered(id, [])).toBe(id)
      expect(liftIfCovered(alphas(shown()).id, [])).toBeUndefined()
    })
  })

  it('words the new marker reason', () => {
    expect(notDrawnText('unrevealed')).toMatch(/could not tell what reveals it/)
  })
})
