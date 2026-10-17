/**
 * #985: sprite $CA, the Torpedo Ted launcher, is drawn by running the ROM's own shooter code
 * (LaunchTorpedo, LauncherArm), never from a table in the editor. The synthetic block (no ROM, so CI runs it)
 * hand-assembles both routines and the dispatch into the synthetic cart with NON-vanilla bytes, offsets and tile
 * (the effect is SMWDisX bank_02.asm:6835-6902 and 3969-4003), so a hardcoded vanilla offset, tile or attribute
 * goes red and no ROM routine is committed. The corpus block runs the real ROM.
 */
import { describe, expect, it } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { spanFingerprint } from '../../../../src/rom/SubmapFlagGate'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { parseLevelSprites, type LevelSprite } from '../../../../src/rom/LevelParser'
import { bytesAt } from '../../../../src/rom/sprites/interp/Guards'
import { levelSeed } from '../../../../src/rom/sprites/interp/LevelLoader'
import { withSeed } from '../../../../src/rom/sprites/interp/SpriteSeed'
import type { SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import {
  torpedoLauncher,
  VANILLA_LAUNCHER_ROUTINES,
  type LauncherRoutines,
} from '../../../../src/rom/sprites/interp/TorpedoLauncher'
import { drawSprites, interpDrawer } from '../../../../theia/extension/src/node/map-sprites'
import { hasRom, romPath, VANILLA } from '../../support/corpus'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const LEVEL = 0x105
const off = (snes: number) => (snes >>> 16) * 0x8000 + ((snes & 0xffff) - 0x8000)
const LAUNCH = 0x02b3b6
const ARM = 0x029e3d
/** The guard hashes whole routines of these lengths; the cart's shorter ones sit in zero padding. */
const LAUNCH_SPAN = 174
const ARM_SPAN = 69

/** LaunchTorpedo's effect: sprite slot 0 = $44 status 8 at the shooter, extended slot 0 = $08 at X + ARM_DX, Y - 7. */
const ARM_DX = 9
const ARM_DY = -7
// prettier-ignore
const launch = [
  ...[0xa9, 0x44, 0x85, 0x9e, 0xa9, 0x08, 0x8d, 0xc8, 0x14], // number $44, status 8
  ...[0xad, 0x9b, 0x17, 0x85, 0xe4, 0xad, 0xa3, 0x17, 0x8d, 0xe0, 0x14], // sprite X from the shooter
  ...[0xad, 0x8b, 0x17, 0x85, 0xd8, 0xad, 0x93, 0x17, 0x8d, 0xd4, 0x14], // sprite Y from the shooter
  ...[0xa9, 0x08, 0x8d, 0x0b, 0x17], // extended sprite 0 = $08
  ...[0xad, 0x9b, 0x17, 0x18, 0x69, ARM_DX, 0x8d, 0x1f, 0x17], // arm X low
  ...[0xad, 0x8b, 0x17, 0x38, 0xe9, -ARM_DY, 0x8d, 0x15, 0x17, 0x60], // arm Y low, RTS
]
/** LauncherArm's effect: OAM 40 at (arm - Layer 1), tile $A5, attribute $21, 16 x 16. */
const OAM_ENTRY = 40
// prettier-ignore
const arm = [
  ...[0xad, 0x1f, 0x17, 0x38, 0xe5, 0x1a, 0x8d, 0xa0, 0x02],
  ...[0xad, 0x15, 0x17, 0x38, 0xe5, 0x1c, 0x8d, 0xa1, 0x02],
  ...[0xa9, 0xa5, 0x8d, 0xa2, 0x02, 0xa9, 0x21, 0x8d, 0xa3, 0x02, 0xa9, 0x02, 0x8d, 0x48, 0x04, 0x60],
]
const LOADER_AT = 0x02a8d4
const DISPATCH_AT = 0x02b3ab

function launcherRom(tweak: (bytes: Uint8Array) => void = () => {}) {
  const bytes = new Uint8Array(buildSyntheticRom().buffer)
  const put = (snes: number, b: number[]) => {
    expect(bytes.subarray(off(snes), off(snes) + b.length).every(v => v === 0)).toBe(true)
    bytes.set(b, off(snes))
  }
  put(LOADER_AT, [0xc9, 0xc9, 0x90, 0x05, 0x20, 0x78, 0xab, 0x80, 0x7f]) // the loader route
  put(DISPATCH_AT, [0x3a, 0x22, 0xfa, 0x86, 0x00, 0x00, 0x00, 0xb6, 0xb3, 0x00, 0x00]) // dispatch to the cart's ExecutePtr
  put(LAUNCH, launch)
  put(ARM, arm)
  tweak(bytes)
  return RomFile.fromBytes('launcher.sfc', bytes)
}

/** This cart's own routine fingerprints (the vanilla ones are for the vanilla bytes). */
const sha = (rom: RomFile, at: number, n: number) =>
  spanFingerprint(Uint8Array.from(bytesAt(rom, at, n)!))!
const routinesOf = (rom: RomFile): LauncherRoutines => ({ launch: sha(rom, LAUNCH, LAUNCH_SPAN), arm: sha(rom, ARM, ARM_SPAN) }) // prettier-ignore

const SHOOTER = { x: 0x120, y: 0x90 }
const CAMERA = { x: 0x40, y: 0x20 }
const seedOf = (rom: RomFile, over = {}) =>
  withSeed(
    { sprite: SHOOTER, camera: CAMERA, mario: { x: 0x10, y: 0x90 }, ...over },
    levelSeed(rom, LEVEL),
  )
const run = (rom: RomFile, routines = routinesOf(rom), over = {}) =>
  torpedoLauncher(rom, seedOf(rom, over), undefined, routines)
const ok = (rom: RomFile, routines?: LauncherRoutines, over = {}) => {
  const r = run(rom, routines, over)
  if (!r.ok) throw new Error(r.reason)
  return r
}
/** Sets a byte inside a routine's zero padding, past its RTS: never executed, but inside the hashed span. */
const touchTail = (at: number) => (b: Uint8Array) => void (b[off(at)] = 0xea)
const NO_SPAWN = 'the launcher spawned no torpedo and arm (off screen or too near the left edge)'

describe('Torpedo Ted launcher from the routines (synthetic cart)', () => {
  it('the cart carries no ROM routine: its fingerprints differ from the vanilla ones', () => {
    const mine = routinesOf(launcherRom())
    expect(mine.launch).not.toBe(VANILLA_LAUNCHER_ROUTINES.launch)
    expect(mine.arm).not.toBe(VANILLA_LAUNCHER_ROUTINES.arm)
  })

  it("the torpedo is where the cart spawned it, and the arm is the cart's own OAM entry, verified", () => {
    const r = ok(launcherRom())
    expect(r.torpedo).toEqual(SHOOTER)
    // OAM X/Y are the arm minus Layer 1; dx/dy are relative to the shooter: the cart's offsets, not the game's.
    expect(r.arm.map(p => [p.oam, p.ox, p.oy, p.char, p.attr, p.size, p.dx, p.dy])).toEqual([
      [OAM_ENTRY, SHOOTER.x + ARM_DX - CAMERA.x, SHOOTER.y + ARM_DY - CAMERA.y, 0xa5 | (1 << 8), 0x21, 16, ARM_DX, ARM_DY], // prettier-ignore
    ])
    expect(r.arm[0]).toMatchObject({ palette: 8, priority: 2, flipX: false, flipY: false })
    expect(r.unverified).toEqual([])
  })

  it('moving the shooter or the camera moves the result with it (nothing is fixed)', () => {
    const moved = { sprite: { x: 0x150, y: 0xb0 }, camera: { x: 0x90, y: 0x40 } }
    const r = ok(launcherRom(), undefined, moved)
    expect([r.torpedo, r.arm[0]!.ox, r.arm[0]!.oy]).toEqual([{ x: 0x150, y: 0xb0 }, 0x150 + ARM_DX - 0x90, 0xb0 + ARM_DY - 0x40]) // prettier-ignore
  })

  it('planted: a launcher whose arm routine draws nothing is reported unverified, not passed as whole', () => {
    // The arm routine is only RTS: the hand is omitted. A test that asserted just "ok" would pass this.
    const r = ok(launcherRom(b => void (b[off(ARM)] = 0x60)))
    expect(r.arm).toEqual([])
    expect(r.unverified).toEqual(['the launcher arm drew no tile'])
  })

  it('planted: a launcher that spawns nothing refuses with its reason', () => {
    expect(run(launcherRom(b => void (b[off(LAUNCH)] = 0x60)))).toEqual({ ok: false, reason: NO_SPAWN }) // prettier-ignore
  })

  it.each([
    ['launch', LAUNCH + LAUNCH_SPAN - 4, 'the launcher routine'],
    ['arm', ARM + ARM_SPAN - 4, 'the launcher arm routine'],
  ])(
    'a byte changed in the %s routine runs it anyway, unverified, naming it (ruling B)',
    (_, at, what) => {
      const want = routinesOf(launcherRom())
      const dirty = launcherRom(touchTail(at))
      expect(ok(dirty, want).unverified).toEqual([what])
      expect(ok(dirty, want).arm).toEqual(ok(launcherRom(), want).arm)
    },
  )

  it('a hacked loader route still draws, unverified, naming it (ruling B)', () => {
    const dirty = launcherRom(b => void (b[off(LOADER_AT + 2)]! ^= 1))
    expect(ok(dirty, routinesOf(launcherRom())).unverified).toEqual(['the loader route to the shooter']) // prettier-ignore
  })

  // The dispatch bytes the check reads are the ones the run follows, so a change there cannot run on: it refuses.
  it.each([DISPATCH_AT + 2, DISPATCH_AT + 7])(
    'a changed dispatch byte ($%s) refuses, it is not drawn from the wrong code',
    at => {
      // prettier-ignore
      expect(run(launcherRom(b => void (b[off(at)]! ^= 1)), routinesOf(launcherRom())).ok).toBe(false)
    },
  )

  it('a level the loader refused has no launcher, and says why', () => {
    const rom = launcherRom()
    expect(torpedoLauncher(rom, { ...seedOf(rom), loaded: undefined, loadRefusal: 'because' })).toEqual({ ok: false, reason: 'because' }) // prettier-ignore
  })

  it('a hard failure is a refusal with its reason', () => {
    expect(run(launcherRom(b => void (b[off(ARM)] = 0x00)))).toEqual({ ok: false, reason: 'BRK executed at $029E3D' }) // prettier-ignore
  })
})

describe('Torpedo Ted launcher on the map (synthetic cart)', () => {
  const rom = launcherRom()
  const sprite: LevelSprite = { index: 3, x: SHOOTER.x / 16, y: SHOOTER.y / 16, spriteId: 0xca, screen: 1, extraBit: false, raw: [0, 0, 0xca], streamOffset: 1 } // prettier-ignore
  const shape = { isVertical: false, screenCount: 4 }
  const TORPEDO_CHAR = 0xc0
  /** The injected sprite run: sprite $44 as one 16 x 16 piece at its anchor, which its INIT left 2 px right of where it spawned. */
  const torpedoRun = (id: number, spawn: { x: number; y: number }): SpriteModel => ({
    id,
    seedSource: 'rom-level-load',
    anchor: { x: spawn.x + 2, y: spawn.y, rawX: spawn.x, rawY: spawn.y },
    chosen: 0,
    dependsOn: [],
    steps: [],
    passes: [{ pass: 0, pos: spawn, origin: spawn, uploads: [], palette: [], parts: [{ oam: 7, char: TORPEDO_CHAR, size: 16, palette: 14, priority: 2, flipX: false, flipY: false, dx: 0, dy: 0, attr: 0, ox: 0, oy: 0 }] }], // prettier-ignore
  })
  const draw = (cart = rom) => {
    const base = levelSeed(cart, LEVEL)
    const seen: { id: number; sprite: { x: number; y: number } }[] = []
    const d = interpDrawer(cart, LEVEL, shape, (_r, id, seed) => (seen.push({ id, sprite: seed.sprite }), torpedoRun(id, seed.sprite)), () => base) // prettier-ignore
    return { res: d(sprite), seen }
  }

  it('is one sprite at the shooter: the arm and the torpedo, the torpedo run as $44 at the spot the launcher spawned it', () => {
    const { res, seen } = draw()
    if (!res.ok) throw new Error(res.reason)
    expect(seen).toEqual([{ id: 0x44, sprite: SHOOTER }])
    expect(res.anchor).toEqual(SHOOTER)
    // A 16 x 16 piece is four chars. Torpedo: INIT left it 2 px right, so dx + 2. Arm: the cart's offsets.
    const quad = (char: number, dx: number, dy: number) =>
      [[0, 0, 0], [8, 0, 1], [0, 8, 16], [8, 8, 17]].map(([x, y, n]) => [0x400 + char + n!, dx + x!, dy + y!]) // prettier-ignore
    const want = [...quad(TORPEDO_CHAR, 2, 0), ...quad(0x1a5, ARM_DX, ARM_DY)]
    expect(res.parts.map(p => [p.charNum, p.dx, p.dy]).sort()).toEqual(want.sort())
    // The cart's routines are not the vanilla ones the drawer's guard fingerprints: the draw says so, and still draws (D52).
    expect('unverified' in res && res.unverified).toContain(
      'the launcher routine is not the vanilla shape',
    )
  })

  it('drawSprites draws it, not the marker: the bitmap spans the arm and the torpedo', () => {
    const base = levelSeed(rom, LEVEL)
    const d = interpDrawer(rom, LEVEL, shape, (_r, id, seed) => torpedoRun(id, seed.sprite), () => base) // prettier-ignore
    const sheet = () => Array.from({ length: 128 }, () => new Uint8Array(64).fill(3))
    const vram = { sp1: sheet(), sp2: sheet(), sp3: sheet(), sp4: sheet() }
    const [dto] = drawSprites(
      [sprite],
      { vram, colors: Array(256).fill([9, 9, 9, 255]) } as never,
      d,
    )
    expect(dto!.status).toBe('drawn')
    // Arm X + 9 .. X + 25, Y - 7 .. Y + 9; torpedo X + 2 .. X + 18, Y .. Y + 16.
    expect(dto!.box).toEqual({ x0: SHOOTER.x + 2, y0: SHOOTER.y + ARM_DY, x1: SHOOTER.x + ARM_DX + 16, y1: SHOOTER.y + 16 }) // prettier-ignore
  })

  it('a launcher the routines cannot run is the marker with the reason (D52)', () => {
    expect(draw(launcherRom(b => void (b[off(LAUNCH)] = 0x60))).res).toEqual({ ok: false, reason: NO_SPAWN }) // prettier-ignore
  })

  it('the other ids above the ordinary range keep the marker: $C9 is not run as a launcher', () => {
    const base = levelSeed(rom, LEVEL)
    const run = (_r: RomFile, id: number): SpriteModel => ({ id, passes: [], dependsOn: [], steps: [], refusal: 'no handler' }) // prettier-ignore
    const d = interpDrawer(rom, LEVEL, shape, run, () => base)
    expect(d({ ...sprite, spriteId: 0xc9 })).toEqual({ ok: false, reason: 'refused: no handler' })
  })
})

/** The $CA shooters of map $011 (vanilla USA ROM, the stream parsed once). */
const SHOOTERS_011 = 19

describe.skipIf(!hasRom(VANILLA))('Torpedo Ted launcher, vanilla ROM map $011', () => {
  it(`all ${SHOOTERS_011} launchers: a verified 16 x 16 arm at X + 8, Y - 9 (tile $84 on name table 1, attribute $13), the torpedo at the shooter`, () => {
    const rom = RomFile.load(romPath(VANILLA))
    const stream = parseLevelSprites(
      rom.readUpTo(new SmwRom(rom).getLevelSpritePointer(0x11)!, 0x200)!,
      false,
    )
    const launchers = stream.filter(s => s.spriteId === 0xca)
    expect(launchers).toHaveLength(SHOOTERS_011)
    const base = levelSeed(rom, 0x11)
    for (const s of launchers) {
      const [x, y] = [s.x * 16, s.y * 16]
      const camera = { x: Math.max(0, x - 128), y: Math.max(0, Math.min(208, y - 112)) }
      const r = torpedoLauncher(rom, withSeed({ sprite: { x, y }, camera, mario: { x: 0x20, y: 0x180 } }, base)) // prettier-ignore
      if (!r.ok) throw new Error(`#${s.index}: ${r.reason}`)
      expect(r.unverified).toEqual([])
      expect(r.torpedo).toEqual({ x, y })
      expect(r.arm.map(p => [p.char, p.attr, p.size, p.palette, p.priority, p.dx, p.dy])).toEqual([[0x184, 0x13, 16, 9, 1, 8, -9]]) // prettier-ignore
      expect([r.arm[0]!.ox, r.arm[0]!.oy]).toEqual([x + 8 - camera.x, y - 9 - camera.y])
    }
  })

  it("the vanilla routine fingerprints are the ROM's (the guard is not vacuous)", () => {
    const rom = RomFile.load(romPath(VANILLA))
    expect({ launch: sha(rom, LAUNCH, LAUNCH_SPAN), arm: sha(rom, ARM, ARM_SPAN) }).toEqual(VANILLA_LAUNCHER_ROUTINES) // prettier-ignore
  })
})
