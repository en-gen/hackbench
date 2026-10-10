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
import { beforeAll, describe, it, expect, vi } from 'vitest'
import { parseLevelSprites, type LevelSprite } from '../../../src/rom/LevelParser'
import { Char } from '../../../src/rom/model/chars/Char'
import { StaticPixelsBehavior } from '../../../src/rom/model/chars/behaviors/StaticPixelsBehavior'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { readSpriteTileTables, WALL_FOLLOW_ATTR_ADDR } from '../../../src/rom/SpriteTileLoader'
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
function servedParts(
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
  return got.parts
}

const servedFlips = (...a: Parameters<typeof servedParts>) => servedParts(...a).map(p => p.flipX)

/** A char for every OBJ char number the interpreter can name, so the model's part ids are comparable. */
const OBJ_CHARS = new Map(
  Array.from({ length: 0x200 }, (_, i) => [0x400 + i, new Char(0x400 + i, new StaticPixelsBehavior(new Uint8Array(64)))] as const), // prettier-ignore
)

/** Corner keys (char, flip, offset from the set's top-left), order-free. */
const keys = (ps: { charNum: number; flipX: boolean; dx: number; dy: number }[]) => {
  const [mx, my] = [Math.min(...ps.map(p => p.dx)), Math.min(...ps.map(p => p.dy))]
  return ps.map(p => [p.charNum, +p.flipX, p.dx - mx, p.dy - my].join(',')).sort()
}

const allSame = (f: boolean[], v: boolean) => f.length === 4 && f.every(x => x === v)

/** The facing rule, asserted over a sweep of Mario's X on both sides and at equal X. */
function expectFacing(
  rom: RomFile,
  map: number,
  shape: { isVertical: boolean; screenCount: number },
  s: LevelSprite,
) {
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
        const model = buildSprites(rom.rom, [s], OBJ_CHARS, [], { x: marioX, y: 0 }, new Map())
        const modelParts = (model[0].appearance as SpikeTopAppearance).parts0
        const served = servedParts(rom.rom, map, shape, s, marioX)
        const at = `map ${map.toString(16)} x=${x} Mario ${marioX}`
        // Char, flip and position of every corner, positions relative to the set's own corner.
        expect(keys(modelParts.map(p => ({ charNum: p.char.id, ...p }))), at).toEqual(keys(served))
        poses[
          allSame(
            served.map(p => p.flipX),
            false,
          )
            ? 'unflipped'
            : 'flipped'
        ]++
      }
    }
    expect(poses.unflipped).toBeGreaterThan(0)
    expect(poses.flipped).toBeGreaterThan(0)
  }, 120_000)
})

// $02:BD17 = file $13D17: ORA.W DATA_02BCC7,Y (bank_02.asm:8089) = 19 C7 BC.
const gatedRom = (patch?: (b: Buffer) => void): RomFile => {
  const buf = Buffer.alloc(0x400000, 0)
  buf[0x7fd5] = 0x20 // LoROM marker
  buf.set([0x19, 0xc7, 0xbc], 0x13d17)
  patch?.(buf)
  return new RomFile('mock.smc', buf)
}

describe('readSpriteTileTables gates the $02BCC7 read on WallFollowersMain (synthetic)', () => {
  it('gate bytes present: the table is read', () => {
    expect(readSpriteTileTables(gatedRom())?.wallFollowAttr).toHaveLength(16)
  })
  it.each([
    ['opcode changed (LDA abs,Y)', 0x13d17, 0xb9],
    ['operand low changed', 0x13d18, 0xc8],
    ['operand high changed', 0x13d19, 0xbd],
  ])('%s: the table is absent, the rest kept', (_n, at, v) => {
    const t = readSpriteTileTables(gatedRom(b => (b[at] = v)))
    expect(t).not.toBeNull()
    expect(t!.wallFollowAttr).toBeUndefined()
    expect(t!.tilemap.length).toBeGreaterThan(0)
  })
})

describe('readSpriteTileTables without the $02BCC7 table (synthetic)', () => {
  it('a failed wall-follow read leaves that table absent and keeps the rest', () => {
    const rom = gatedRom()
    expect(readSpriteTileTables(rom)?.wallFollowAttr).toBeInstanceOf(Uint8Array)
    const real = rom.readAt.bind(rom)
    vi.spyOn(rom, 'readAt').mockImplementation((a, n) =>
      a === WALL_FOLLOW_ATTR_ADDR ? null : real(a, n),
    )
    const t = readSpriteTileTables(rom)
    expect(t).not.toBeNull()
    expect(t!.wallFollowAttr).toBeUndefined()
    expect(t!.tilemap.length).toBeGreaterThan(0)
  })
})
