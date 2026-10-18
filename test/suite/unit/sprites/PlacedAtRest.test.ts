/**
 * The at-rest mode (D134, D91, #980): a sprite is drawn by its own MAIN from the placed (list) spot and INIT
 * never runs. The synthetic block needs no ROM; the corpus block runs the real chainsaws and grinders.
 */
import { describe, it, expect } from 'vitest'
import { runOnce } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { SPRITE_SEED, withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { interpRunner } from '../../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { VANILLA, hasRom, romPath } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()

describe('at-rest mode on a synthetic cart', () => {
  // Id 0: INIT adds 8 to X; MAIN draws one piece at the sprite position.
  it('draws at the placed spot with INIT never executed', () => {
    const m = runOnce(rom, 0, SPRITE_SEED, { init: false })
    expect(m.refusal).toBeUndefined()
    expect(m.anchor).toMatchObject({ x: 0x80, y: 0x80, rawX: 0x80, rawY: 0x80 })
    expect(m.initFrames).toBe(0)
    expect(m.chosen).toBe(0)
    expect(m.passes[0]!.parts[0]).toMatchObject({ dx: 0, dy: 0 })
  })
  it('leaves what INIT would write untouched (id 20: INIT sets a CGRAM color)', () => {
    expect(runOnce(rom, 20, SPRITE_SEED).passes[0]!.palette.length).toBeGreaterThan(0)
    expect(runOnce(rom, 20, SPRITE_SEED, { init: false }).passes[0]!.palette).toEqual([])
  })
  it('the default still runs INIT (graders, timelines)', () => {
    const m = runOnce(rom, 0, SPRITE_SEED)
    expect(m.initFrames).toBe(1)
    expect(m.anchor).toMatchObject({ x: 0x88, rawX: 0x80 })
    expect(runOnce(rom, 0, SPRITE_SEED, { init: true }).anchor?.x).toBe(0x88)
  })
  it('follows the seed: a different placed spot moves the picture with it', () => {
    const m = runOnce(rom, 0, withSeed({ sprite: { x: 0x140, y: 0x90 } }), { init: false })
    expect(m.anchor).toMatchObject({ x: 0x140, y: 0x90 })
  })
})

describe.skipIf(!hasRom(VANILLA))('at rest on vanilla', () => {
  const bytes = () => new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)
  const placed = (map: number, id: number) => {
    const b = bytes()
    const smw = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const built = new L1ModelCache().get(b, romPath(VANILLA), map, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
    if (!built.ok) throw new Error(built.reason)
    const list = parseLevelSprites(smw.rom.readUpTo(smw.getLevelSpritePointer(map)!, 0x200)!, built.inputs.isVertical).filter(s => s.spriteId === id) // prettier-ignore
    const run = interpRunner(smw.rom, map, built.inputs)
    return list.map(s => ({ s, r: run(s) }))
  }
  for (const [map, id] of [
    [0x0f, 0x65],
    [0x1a, 0x67],
  ] as const)
    it(`every $${id.toString(16)} on map $${map.toString(16)} draws at its list position`, () => {
      const got = placed(map, id)
      expect(got.length).toBeGreaterThan(0)
      for (const { s, r } of got) {
        if (!('m' in r)) throw new Error('direct answer')
        expect(r.m.refusal).toBeUndefined()
        expect([r.m.anchor?.x, r.m.anchor?.y]).toEqual([s.x * 16, s.y * 16])
        expect(r.m.anchor).toMatchObject({ rawX: s.x * 16, rawY: s.y * 16 })
        expect(r.m.chosen).toBe(0)
      }
    })
})
