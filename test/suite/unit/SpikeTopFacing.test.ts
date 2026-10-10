/**
 * Spike Top ($2E) facing (#134), on the path the map view serves: the 65816
 * interpreter running InitSpikeTop (bank_01.asm:602) with Mario's X set either
 * side of the sprite. Corpus blocks only; the model path's synthetic cover is in
 * model/SpriteFactory.synthetic.test.ts and model/SpikeTopAppearance.test.ts.
 *
 * What the ROM does (bank_01.asm:602-612, 620-627, 4166-4171; bank_02.asm:8057-8089):
 * Mario strictly left gives direction $C2 = 4, else 0; the drawn attribute is
 * DATA_02BCC7[$C2] with OBJ_XFlip then EORed in by SubSprGfx2Entry1 ($157C = 0). So
 * Mario left draws unflipped and Mario right or level draws X-flipped. Evidence
 * scope: vanilla US 1.0, one level (the pose) and all 44 vanilla placements (the sweep).
 */
import { beforeAll, describe, it, expect } from 'vitest'
import { parseLevelSprites, type LevelSprite } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildSprites } from '../../../src/rom/model/SpriteFactory'
import type { SpikeTopAppearance } from '../../../src/rom/model/sprites/appearances/SpikeTopAppearance'
import {
  resolveLoop,
  resolvePointer,
  resolveTables,
} from '../../../src/rom/sprites/interp/SpriteDispatch'
import { runOnce } from '../../../src/rom/sprites/interp/SpriteRunner'
import { interpDrawer } from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { VANILLA, freshRom, hasRom, romPath } from '../support/corpus'

const NO_FLAGS = { yellow: false, green: false, red: false, blue: false }
const SPIKE_TOP = 0x2e

/** Every map with a Spike Top placement, with the map's own shape for the drawer. */
function placements(bytes: Uint8Array) {
  const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(bytes)))
  const out: { map: number; s: LevelSprite; shape: { isVertical: boolean; screenCount: number } }[] = [] // prettier-ignore
  for (let map = 0; map < 0x200; map++) {
    const ptr = rom.getLevelSpritePointer(map)
    const data = ptr === null ? null : rom.rom.readUpTo(ptr, 0x200)
    if (!data) continue
    // The horizontal parse finds the ids; the map's shape is only built when one is there.
    if (!parseLevelSprites(data, false).some(s => s.spriteId === SPIKE_TOP)) continue
    const built = new L1ModelCache().get(bytes, romPath(VANILLA), map, NO_FLAGS)
    if (!built.ok) throw new Error(`map ${map}: ${built.reason}`)
    for (const s of parseLevelSprites(data, built.inputs.isVertical))
      if (s.spriteId === SPIKE_TOP) out.push({ map, s, shape: built.inputs })
  }
  return { rom, out }
}

/** The served parts' X flips for one placement, with Mario's X forced to `marioX` (null: the level's own). */
function servedFlips(
  rom: RomFile,
  map: number,
  shape: { isVertical: boolean; screenCount: number },
  s: LevelSprite,
  marioX: number | null,
) {
  // prettier-ignore
  const run = (r: RomFile, id: number, seed: Parameters<typeof runOnce>[2]) =>
    runOnce(r, id, marioX === null ? seed : { ...seed, mario: { ...seed.mario, x: marioX } })
  const got = interpDrawer(rom, map, shape, run)(s)
  if (!got.ok) throw new Error(got.reason)
  return got.parts.map(p => p.flipX)
}

const allSame = (f: boolean[], v: boolean) => f.length === 4 && f.every(x => x === v)

/** The facing rule, asserted over a sweep of Mario's X on both sides and at equal X. */
function expectFacing(
  rom: RomFile,
  map: number,
  shape: { isVertical: boolean; screenCount: number },
  s: LevelSprite,
) {
  // prettier-ignore
  const x = s.x * 16
  for (const m of [x - 200, x - 17, x - 1]) expect(allSame(servedFlips(rom, map, shape, s, Math.max(0, m)), false), `Mario at ${m}`).toBe(true) // prettier-ignore
  for (const m of [x, x + 1, x + 17, x + 200]) expect(allSame(servedFlips(rom, map, shape, s, m), true), `Mario at ${m}`).toBe(true) // prettier-ignore
}

describe.skipIf(!hasRom(VANILLA))('served Spike Top facing (interpreter, vanilla)', () => {
  // Built in beforeAll: a describe body runs at collection even when the block is skipped.
  let rom: SmwRom
  let out: ReturnType<typeof placements>['out']
  let pick: (typeof out)[number]
  beforeAll(() => {
    ;({ rom, out } = placements(new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)))
    // A placement far enough right that Mario can stand 200 px to its left.
    pick = out.find(p => p.s.x * 16 >= 400)!
  }, 120_000)

  it('draws unflipped with Mario strictly left and X-flipped with Mario level or right', () => {
    expect(out.length).toBe(44)
    expectFacing(rom.rom, pick.map, pick.shape, pick.s)
  })

  it('goes red on a planted defect: EOR #$01 in the INIT handler turned into EOR #$00 inverts the facing', () => {
    const cart = freshRom()
    // The handler is found through the cart's own tables, then by the bytes
    // JSR SubHorizPos / TYA / EOR #$01, never by a fixed address.
    const loop = resolveLoop(cart)
    const tables = resolveTables(cart, loop.ok ? loop.handle : 0)
    if (!tables.ok) throw new Error(tables.reason)
    const init = resolvePointer(cart, tables.tables.initTable, SPIKE_TOP)
    if (!init.ok) throw new Error(init.reason)
    const code = cart.readAt(init.handler.address, 8)!
    expect([code[0], code[3], code[4], code[5]]).toEqual([0x20, 0x98, 0x49, 0x01])
    cart.writeAt(init.handler.address + 5, [0x00])
    expect(() => expectFacing(cart, pick.map, pick.shape, pick.s)).toThrow()
    // And the inverse holds: the planted cart is not merely unreadable, it faces the other way.
    const x = pick.s.x * 16
    expect(allSame(servedFlips(cart, pick.map, pick.shape, pick.s, x - 17), true)).toBe(true)
    expect(allSame(servedFlips(cart, pick.map, pick.shape, pick.s, x + 17), false)).toBe(true)
  })

  it('the model path draws what the served path draws for the same Mario X, on every vanilla placement', () => {
    const poses = { unflipped: 0, flipped: 0 }
    for (const { map, s, shape } of out) {
      const x = s.x * 16
      // Each placement with Mario just left, level and just right of it: the model's own
      // start puts Mario left on all 44, so one pose alone would prove little.
      for (const marioX of [Math.max(0, x - 1), x, x + 40]) {
        const model = buildSprites(rom.rom, [s], new Map(), [], { x: marioX, y: 0 }, new Map())
        const modelFlips = (model[0].appearance as SpikeTopAppearance).parts0.map(p => p.flipX)
        const served = servedFlips(rom.rom, map, shape, s, marioX)
        expect(modelFlips, `map ${map.toString(16)} x=${x} Mario ${marioX}`).toEqual(served)
        poses[allSame(served, false) ? 'unflipped' : 'flipped']++
      }
    }
    expect(poses.unflipped).toBeGreaterThan(0)
    expect(poses.flipped).toBeGreaterThan(0)
  }, 120_000)
})
