/**
 * #984: the Properties view's sprite subject. Everything is derived from the `MapSpriteDto` the map view
 * draws from, so the parts list, palette rows and box cannot drift from the picture. Synthetic chars and
 * DTOs only (no ROM bytes); CI needs no cart.
 */
import { describe, it, expect } from 'vitest'
import type { EngineResult } from '../../../src/rom/model/sprites/generic/SpriteDrawEngine'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { drawSprites } from '../../../theia/extension/src/node/map-sprites'
import {
  animationText,
  framesReasonText,
  shiftNote,
  spriteProps,
} from '../../../theia/extension/src/browser/sprite-props'
import { followSubject } from '../../../theia/extension/src/browser/properties-follow'
import { FramePlayer, type FramesState } from '../../../theia/extension/src/browser/sprite-frames'
import { PropertiesModel } from '../../../theia/extension/src/browser/properties-model'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import { COLORS } from '../support/mapInputs'

const SOLID = new Uint8Array(64).fill(1)
const MODEL = { vram: { sp1: [SOLID, SOLID] }, colors: COLORS }
const spr = (x: number, y: number, spriteId = 0x10): LevelSprite =>
  ({
    index: 0,
    x,
    y,
    spriteId,
    screen: 0,
    extraBit: false,
    raw: [],
    streamOffset: 0,
  }) as LevelSprite
const part = (charNum: number, palette: number, dx: number, dy: number, flipX = false) => ({
  charNum,
  palette,
  flipX,
  flipY: false,
  dx,
  dy,
})
const ok = (...parts: ReturnType<typeof part>[]): EngineResult =>
  ({ ok: true, parts, identity: { spriteId: 0x10, mainHandler: 0, initHandler: 0, status: 'vanilla' } }) as EngineResult // prettier-ignore

const PARTS = [part(0x400, 9, 0, 0), part(0x401, 10, 8, 0, true), part(0x400, 9, -8, 8)]
const draw = (id = 0x10) => drawSprites([spr(5, 3, id)], MODEL, () => ok(...PARTS))[0]!

describe('spriteProps: the parts are the ones the map view drew (acceptance 5)', () => {
  it('lists every part drawSprites placed, with the palette rows they use', () => {
    const p = spriteProps({ ...draw(), name: 'Rex' })
    expect(p.parts).toHaveLength(PARTS.length)
    expect(p.parts!.map(x => x.palette)).toEqual(PARTS.map(x => x.palette))
    expect(p.parts![1]).toMatchObject({ char: 0x401, flipX: true, flipY: false, dx: 8, dy: 0 })
    expect(p.paletteRows).toEqual([9, 10])
  })

  it('the parts span exactly the bitmap box the view draws', () => {
    const dto = draw()
    const xs = dto.parts!.map(q => q.dx)
    const ys = dto.parts!.map(q => q.dy)
    const b = { x0: Math.min(...xs), y0: Math.min(...ys), x1: Math.max(...xs) + 8, y1: Math.max(...ys) + 8 } // prettier-ignore
    expect({ x0: dto.x + b.x0, y0: dto.y + b.y0, x1: dto.x + b.x1, y1: dto.y + b.y1 }).toEqual(
      dto.box,
    )
  })

  it('a placeholder has no parts to list and says why', () => {
    const [m] = drawSprites([spr(1, 1, 0x1a)], MODEL, () => ({ ok: false, failure: { kind: 'noDescriptor', spriteId: 0x1a } }) as EngineResult) // prettier-ignore
    const p = spriteProps(m!)
    expect(p.parts).toBeNull()
    expect(p.paletteRows).toEqual([])
    expect(p.notes.join(' ')).toMatch(/not drawn/i)
  })
  it.each(['customHandler', 'refused: halted at 0x8000', 'drew no OAM tile', 'something new'])(
    'a "%s" placeholder shows plain words, with the raw reason only as rawReason',
    reason => {
      const [m] = drawSprites([spr(1, 1, 0x1a)], MODEL, () => ({ ok: false, failure: { kind: 'noDescriptor', spriteId: 0x1a } }) as EngineResult) // prettier-ignore
      const p = spriteProps({ ...m!, reason })
      const shown = p.notes.join(' ')
      expect(shown).toMatch(/^Not drawn: [A-Z].*\.$/m)
      expect(shown).not.toContain(reason)
      expect(p.rawReason).toBe(reason)
    },
  )
  it('the note says Behavior (US spelling, as the rest of the UI)', () => {
    expect(spriteProps(draw()).notes.join(' ')).toMatch(/Behavior and extra settings/)
  })
})

describe('spriteProps: identity and position in words', () => {
  it('names the sprite and gives its column and row in 16 px tiles', () => {
    const p = spriteProps({ ...draw(0x33), name: 'Podoboo' })
    expect(p).toMatchObject({ label: 'Podoboo (sprite $33)', col: 5, row: 3 })
  })
  it('an unnamed sprite is still labelled by id', () => {
    expect(spriteProps(draw(0x7e)).label).toBe('Sprite $7E')
  })
})

describe('spriteProps: row and notes', () => {
  it('the row is the 16 px tile the anchor is in: y 56 is row 3, x 88 is column 5', () => {
    expect(spriteProps({ ...draw(), x: 88, y: 56 })).toMatchObject({ col: 5, row: 3 })
  })
  it('an unverified draw says so, and a verified one does not', () => {
    expect(spriteProps({ ...draw(), unverified: 'seed was generic' }).notes).toContain('Unverified: seed was generic.') // prettier-ignore
    expect(spriteProps(draw()).notes.join(' ')).not.toMatch(/unverified/i)
  })
})

describe('spriteProps: a sprite drawn away from its stored tile (R16)', () => {
  const at = (x: number, y: number, stored?: { x: number; y: number }) => ({ ...draw(0x65), x, y, ...(stored ? { stored } : {}) }) // prettier-ignore
  it('says how far it moved, worked out from the two positions: left, right, and with a vertical part', () => {
    expect(shiftNote(at(80, 96, { x: 400, y: 96 }))).toMatch(
      /moves it 320 px to the left before it is first drawn/,
    )
    expect(shiftNote(at(415, 96, { x: 400, y: 96 }))).toMatch(/moves it 15 px to the right before/)
    expect(shiftNote(at(415, 90, { x: 400, y: 96 }))).toMatch(
      /15 px to the right and 6 px up before/,
    )
    expect(shiftNote(at(415, 100, { x: 400, y: 96 }))).toMatch(
      /15 px to the right and 4 px down before/,
    )
  })
  it('says nothing when the picture is on its stored tile or no tile is stored', () => {
    expect(shiftNote(at(400, 96))).toBeUndefined()
    expect(shiftNote(at(400, 96, { x: 400, y: 96 }))).toBeUndefined()
    expect(spriteProps(draw()).notes.join(' ')).not.toMatch(/start-up code/)
  })
  it('reports the stored tile as the sprite position, and carries the note', () => {
    const p = spriteProps(at(80, 96, { x: 400, y: 96 }))
    expect(p).toMatchObject({ col: 25, row: 6 })
    expect(p.notes.join(' ')).toMatch(/The highlighted tile is where the map stores it/)
  })
})

describe('animationText: reasons reach the screen in words', () => {
  const still = (reason?: string): FramesState => ({ kind: 'still', reason })
  it('nothing for idle, a loading line, a count for playing', () => {
    expect(animationText({ kind: 'idle' })).toBeUndefined()
    expect(animationText({ kind: 'loading' })).toMatch(/checking/i)
    expect(animationText({ kind: 'playing', frames: [{}, {}, {}] as MapSpriteDto[], current: 0 })).toBe('Animated: 3 frames, looping.') // prettier-ignore
  })
  it('a plain one-pose sprite is "Not animated"; a refused or fixed one is "Animation not shown" with the reason', () => {
    expect(animationText(still())).toMatch(/^Not animated/)
    for (const r of [
      'refused: MAIN: bad opcode',
      'INIT erased the sprite (status 0)',
      'its parts are fixed to the screen',
      'extraBits',
      'drew no OAM tile in 8 passes (x)',
      'rom-not-located',
      'boom',
    ]) {
      // prettier-ignore
      const t = animationText(still(r))!
      expect(t, r).toMatch(/^Animation not shown: /)
      expect(t, r).not.toMatch(/extraBits|refused:|INIT|status 0|MAIN|boom|\(|not-located/)
    }
  })
  it('reuses the not-drawn wording for extra bits and for no tiles', () => {
    expect(framesReasonText('extraBits')).toMatch(/extra-bits marker/)
    expect(framesReasonText('drew no tile')).toBe('Its code drew no tiles.')
  })
  it('puts the special-routine reason in words, not the generic fallback', () => {
    const t = framesReasonText('it is drawn by a special routine')
    expect(t).toMatch(/its own routine/)
    expect(t).not.toBe(framesReasonText('unknown code'))
  })
})

describe('followSubject: the panel is created after the click that published', () => {
  const sprite = { kind: 'sprite', sprite: { index: 4 } as MapSpriteDto, source: { manifestPath: 'm', index: 1 } } as const // prettier-ignore
  const flush = () => new Promise(r => setTimeout(r, 0))
  it('a sprite published BEFORE following starts its frames at once, not "Not animated"', async () => {
    const model = new PropertiesModel()
    model.publish({}, sprite)
    const player = new FramePlayer(async () => ({ status: 'ok', frames: [{}, {}] as MapSpriteDto[] }), { every: () => 1, stop: () => {} }) // prettier-ignore
    followSubject(model, player, () => {})
    expect(player.state.kind).toBe('loading')
    expect(animationText(player.state)).not.toMatch(/not animated/i)
    await flush()
    expect(player.state.kind).toBe('playing')
  })
  it('the same sprite index on another map restarts the frames; the same map does not', () => {
    const model = new PropertiesModel()
    const picks: { index: number }[] = []
    followSubject(model, { select: s => picks.push(s as { index: number }) }, () => {})
    const o = {}
    const sp = { index: 4 } as MapSpriteDto
    model.publish(o, { kind: 'sprite', sprite: sp, source: { manifestPath: 'm', index: 1 } })
    model.publish(o, { kind: 'sprite', sprite: sp, source: { manifestPath: 'm', index: 1 } })
    model.publish(o, { kind: 'sprite', sprite: sp, source: { manifestPath: 'm', index: 2 } })
    expect(picks.map(p => p.index)).toEqual([1, 2])
  })
  it('nothing published stays idle; later changes restart for a new sprite only', () => {
    const model = new PropertiesModel()
    const picks: unknown[] = []
    let paints = 0
    const sub = followSubject(model, { select: s => picks.push(s) }, () => paints++)
    expect(picks).toEqual([])
    const o = {}
    model.publish(o, sprite)
    model.publish(o, sprite) // the same sprite again: no restart
    model.publish(o, { ...sprite, sprite: { index: 5 } as MapSpriteDto })
    model.clear(o)
    expect(picks).toEqual([
      { manifestPath: 'm', index: 1, spriteIndex: 4 },
      { manifestPath: 'm', index: 1, spriteIndex: 5 },
      undefined,
    ])
    expect(paints).toBe(5)
    sub.dispose()
    model.publish(o, sprite)
    expect(picks).toHaveLength(3)
  })
  it('a sprite with no source has one pose to show and no frames are asked for', () => {
    const picks: unknown[] = []
    const model = new PropertiesModel()
    model.publish({}, { kind: 'sprite', sprite: { index: 1 } as MapSpriteDto })
    followSubject(model, { select: s => picks.push(s) }, () => {})
    expect(picks).toEqual([undefined])
  })
})

describe('PropertiesModel: the subject switches with the map view selection', () => {
  const a = {}
  const b = {}
  const sprite = { kind: 'sprite', sprite: {} as MapSpriteDto } as const
  it('starts empty, shows a published sprite, clears on the owner clear', () => {
    const m = new PropertiesModel()
    const seen: string[] = []
    m.onChange(s => seen.push(s.kind))
    expect(m.subject.kind).toBe('none')
    m.publish(a, sprite)
    expect(m.subject.kind).toBe('sprite')
    m.clear(a)
    expect(m.subject.kind).toBe('none')
    expect(seen).toEqual(['sprite', 'none'])
  })
  it("a map that is not the owner cannot clear another map's sprite (closing a background map)", () => {
    const m = new PropertiesModel()
    m.publish(a, sprite)
    m.publish(b, { kind: 'none' })
    m.clear(a)
    m.publish(b, sprite)
    m.clear(a)
    expect(m.subject.kind).toBe('sprite')
    m.clear(b)
    expect(m.subject.kind).toBe('none')
  })
})
