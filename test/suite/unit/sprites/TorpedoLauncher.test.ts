/**
 * #985: sprite $CA, the Torpedo Ted launcher, is drawn by running the ROM's own shooter code
 * (LaunchTorpedo, LauncherArm), never from a table in the editor. The synthetic block (no ROM, so CI runs it)
 * hand-assembles both routines and the dispatch into the synthetic cart with NON-vanilla bytes, offsets and tile
 * (the effect is SMWDisX bank_02.asm:6835-6902, 3969-4003 and 7469-7500, 7544-7590), so a hardcoded vanilla offset,
 * tile or attribute goes red and no ROM routine is committed. The cart's launch writes the direction ($157C) and
 * the launch timer ($1540) into the spawned slot and its torpedo draw reads them; the arm reads the lock ($9D),
 * its own slot ($15E9) and its X register, so a machine that reruns the sprite, or loses one of those, goes red.
 * The corpus block runs the real ROM.
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
  NO_SPAWN,
  notTheArm,
  VANILLA_LAUNCHER_ROUTINES,
  EXT_DISPATCH,
  EXT_DISPATCH_LENGTH,
  EXT_DISPATCH_WILD,
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

/**
 * LaunchTorpedo's effect: sprite slot 0 = number `spawn` status 8 at the shooter + (TORPEDO_DX, TORPEDO_DY) (an
 * offset, so a run that reuses the shooter's position is wrong), $157C = 1 when Mario is left of the shooter, $1540 =
 * `timer`; extended slot EXT = $08 at X + ARM_DX, Y - 7.
 */
const ARM_DX = 9
const ARM_DY = -7
const TORPEDO_DX = 6
const TORPEDO_DY = 4
const EXT = 3
// prettier-ignore
const launchBytes = (spawn = 0x44, timer = 0x30, status = 0x08, extNum = 0x08, o: { gated?: boolean; bankRead?: boolean } = {}) => [
  ...(o.gated ? [0xad, 0xab, 0x17, 0xf0, 0x01, 0x60] : []), // LDA ShooterTimer / BEQ +1 / RTS: LaunchTorpedo's own gate (bank_02.asm:6836-6837)
  ...(o.bankRead ? [0xad, 0x00, 0xff] : [0xa9, spawn]), 0x85, 0x9e, // the number: an immediate, or a read of $FF00 through DB
  ...[ 0xa9, status, 0x8d, 0xc8, 0x14], // number, status (8: Normal)
  ...[0xad, 0x9b, 0x17, 0x18, 0x69, TORPEDO_DX, 0x85, 0xe4, 0xad, 0xa3, 0x17, 0x8d, 0xe0, 0x14], // sprite X from the shooter
  ...[0xad, 0x8b, 0x17, 0x18, 0x69, TORPEDO_DY, 0x85, 0xd8, 0xad, 0x93, 0x17, 0x8d, 0xd4, 0x14], // sprite Y from the shooter
  ...[0xa5, 0x94, 0xcd, 0x9b, 0x17, 0xa9, 0x00, 0xb0, 0x02, 0xa9, 0x01, 0x8d, 0x7c, 0x15], // $157C = Mario left of the shooter
  ...[0xa9, timer, 0x8d, 0x40, 0x15], // $1540
  ...[0xa9, extNum, 0x8d, 0x0b + EXT, 0x17], // extended sprite EXT
  ...[0xad, 0x9b, 0x17, 0x18, 0x69, ARM_DX, 0x8d, 0x1f + EXT, 0x17], // arm X low
  ...[0xad, 0x8b, 0x17, 0x38, 0xe9, -ARM_DY, 0x8d, 0x15 + EXT, 0x17, 0x60], // arm Y low, RTS
]
/** LauncherArm's effect: OAM 40 at (arm - Layer 1), tile $A4 + lock + slot, attribute $21, 16 x 16. */
const OAM_ENTRY = 40
const ARM_TILE = 0xa4 + 1 + EXT
// prettier-ignore
const arm = [
  ...[0xbd, 0x1f, 0x17, 0x38, 0xe5, 0x1a, 0x8d, 0xa0, 0x02],
  ...[0xbd, 0x15, 0x17, 0x38, 0xe5, 0x1c, 0x8d, 0xa1, 0x02],
  ...[0xa5, 0x9d, 0x18, 0x6d, 0xe9, 0x15, 0x69, 0xa4, 0x8d, 0xa2, 0x02],
  ...[0xa9, 0x21, 0x8d, 0xa3, 0x02, 0xa9, 0x02, 0x8d, 0x48, 0x04, 0x60],
]
/**
 * The cart's Torpedo Ted MAIN (installed as sprite $44's, at TORPEDO_MAIN): one 16 x 16 piece at the sprite, X flip
 * ($40) when $157C is set, attribute base from $0E (the seed's own RAM cell), priority 1 ($10) and tile $C1 while $1540 is set (else tile $C2, priority 0): the
 * facing and the launch timer are the slot's, as TorpedoGfxRt reads them (bank_02.asm:7480-7483, 7544-7590).
 */
const TORPEDO_MAIN = 0x019600
// prettier-ignore
const torpedoMain = [
  0xbc, 0xea, 0x15, 0x38, 0xb5, 0xd8, 0xe5, 0x1c, 0x99, 0x01, 0x03, 0x38, 0xb5, 0xe4, 0xe5, 0x1a, 0x99, 0x00, 0x03,
  0xa5, 0x0e, 0x85, 0x04,
  0xbd, 0x7c, 0x15, 0xf0, 0x04, 0xa9, 0x40, 0x04, 0x04, // X flip: TSB $04 sets the bit
  0xbd, 0x40, 0x15, 0xf0, 0x08, 0xa9, 0x10, 0x04, 0x04, 0xa9, 0xc1, 0x80, 0x02, 0xa9, 0xc2,
  0x99, 0x02, 0x03, 0xa5, 0x04, 0x29, 0xff, 0x99, 0x03, 0x03, 0xa9, 0x02, 0x85, 0x05, 0x98, 0x4a, 0x4a, 0xaa, 0xa5, 0x05, 0x9d, 0x60, 0x04, 0x60,
]
const LOADER_AT = 0x02a8d4
const DISPATCH_AT = 0x02b3ab
/** The extended-sprite loop body and its word table (bank_02.asm:3540-3558); entry $08 is the arm. */
const EXT_AT = 0x029b16
// The cart's own 21 bytes, NOT the ROM's: torpedoLauncher recognizes the span by its fingerprint (JSL operand
// zeroed), which the cart supplies through `routinesOf`; only the JSL to the cart's ExecutePtr is read as bytes.
// prettier-ignore
const EXT_CODE = [0xb5, 0x2b, 0xea, 0xd0, 0x07, 0xa6, 0x41, 0xf0, 0x11, 0xb4, 0x3c, 0xea, 0xd0, 0x05, 0xce, 0x3c, 0x18, 0x22, 0xfa, 0x86, 0x00]
const EXT_ENTRY8 = EXT_AT + EXT_CODE.length + 16

function launcherRom(tweak: (bytes: Uint8Array) => void = () => {}, launch = launchBytes()) {
  const bytes = new Uint8Array(buildSyntheticRom().buffer)
  const put = (snes: number, b: number[]) => {
    expect(bytes.subarray(off(snes), off(snes) + b.length).every(v => v === 0)).toBe(true)
    bytes.set(b, off(snes))
  }
  put(LOADER_AT, [0xc9, 0xc9, 0x90, 0x09, 0x20, 0x34, 0xa1, 0x80, 0x03]) // the loader route (operands are not the ROM's)
  put(DISPATCH_AT, [0x3a, 0x22, 0xfa, 0x86, 0x00, 0x00, 0x00, 0xb6, 0xb3, 0x00, 0x00]) // dispatch to the cart's ExecutePtr
  put(EXT_AT, EXT_CODE)
  put(EXT_ENTRY8, [ARM & 0xff, (ARM >> 8) & 0xff]) // the cart's table: only entry $08 is filled
  put(LAUNCH, launch)
  put(ARM, arm)
  put(TORPEDO_MAIN, torpedoMain)
  // Sprite $44's MAIN pointer (the synthetic cart's table, 2 bytes per id from $01:8329) is the cart's torpedo draw.
  bytes.set([TORPEDO_MAIN & 0xff, (TORPEDO_MAIN >> 8) & 0xff], off(0x018329 + 2 * 0x44))
  tweak(bytes)
  return RomFile.fromBytes('launcher.sfc', bytes)
}

/** This cart's own routine fingerprints (the vanilla ones are for the vanilla bytes). */
const sha = (rom: RomFile, at: number, n: number) =>
  spanFingerprint(Uint8Array.from(bytesAt(rom, at, n)!))!
const extSha = (rom: RomFile) => spanFingerprint(Uint8Array.from(bytesAt(rom, EXT_DISPATCH, EXT_DISPATCH_LENGTH)!), EXT_DISPATCH_WILD)! // prettier-ignore
const routinesOf = (rom: RomFile): LauncherRoutines => ({ launch: sha(rom, LAUNCH, LAUNCH_SPAN), arm: sha(rom, ARM, ARM_SPAN), extDispatch: extSha(rom) }) // prettier-ignore

const SHOOTER = { x: 0x120, y: 0x90 }
const CAMERA = { x: 0x40, y: 0x20 }
const seedOf = (rom: RomFile, over = {}) =>
  withSeed(
    { sprite: SHOOTER, camera: CAMERA, mario: { x: 0x10, y: 0x90 }, ...over, ram: { 0x0e: 0x0a, ...(over as { ram?: object }).ram } }, // prettier-ignore
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

describe('Torpedo Ted launcher from the routines (synthetic cart)', () => {
  it('the cart carries no ROM routine: its fingerprints differ from the vanilla ones', () => {
    const mine = routinesOf(launcherRom())
    expect(mine.launch).not.toBe(VANILLA_LAUNCHER_ROUTINES.launch)
    expect(mine.arm).not.toBe(VANILLA_LAUNCHER_ROUTINES.arm)
    expect(mine.extDispatch).not.toBe(VANILLA_LAUNCHER_ROUTINES.extDispatch)
  })

  it("the torpedo and the arm are the cart's own OAM entries, from the slot it filled, verified", () => {
    const r = ok(launcherRom())
    expect(r.torpedo).toEqual({ x: SHOOTER.x + TORPEDO_DX, y: SHOOTER.y + TORPEDO_DY })
    expect(r.torpedoId).toBe(0x44)
    // OAM X/Y are the part minus Layer 1; dx/dy are relative to the shooter: the cart's offsets, not the game's.
    expect(r.arm.map(p => [p.oam, p.ox, p.oy, p.char, p.attr, p.size, p.dx, p.dy])).toEqual([
      [OAM_ENTRY, SHOOTER.x + ARM_DX - CAMERA.x, SHOOTER.y + ARM_DY - CAMERA.y, ARM_TILE | (1 << 8), 0x21, 16, ARM_DX, ARM_DY], // prettier-ignore
    ])
    expect(r.arm[0]).toMatchObject({ palette: 8, priority: 2, flipX: false, flipY: false })
    // Mario ($10) is left of the shooter ($120): $157C = 1 (X flip), and $1540 is set: priority 1, tile $C1.
    expect(r.torpedoParts.map(p => [p.char, p.attr, p.size, p.dx, p.dy])).toEqual([[0xc1, 0x5a, 16, TORPEDO_DX, TORPEDO_DY]]) // prettier-ignore
    expect(r.torpedoParts[0]).toMatchObject({ flipX: true, priority: 1 })
    expect(r.unverified).toEqual([])
  })

  it("the torpedo's facing and launch-timer look are the slot's, not a fresh run's", () => {
    const right = ok(launcherRom(), undefined, { mario: { x: 0x130, y: 0x90 } }).torpedoParts[0]!
    expect([right.flipX, right.priority, right.char]).toEqual([false, 1, 0xc1])
    const idle = ok(launcherRom(undefined, launchBytes(0x44, 0))).torpedoParts[0]!
    expect([idle.flipX, idle.priority, idle.char]).toEqual([true, 0, 0xc2])
  })

  it('moving the shooter or the camera moves the result with it (nothing is fixed)', () => {
    const moved = { sprite: { x: 0x150, y: 0xb0 }, camera: { x: 0x90, y: 0x40 } }
    const r = ok(launcherRom(), undefined, moved)
    expect([r.torpedo, r.arm[0]!.ox, r.arm[0]!.oy]).toEqual([{ x: 0x150 + TORPEDO_DX, y: 0xb0 + TORPEDO_DY }, 0x150 + ARM_DX - 0x90, 0xb0 + ARM_DY - 0x40]) // prettier-ignore
    expect([r.torpedoParts[0]!.ox, r.torpedoParts[0]!.oy]).toEqual([0x150 + TORPEDO_DX - 0x90, 0xb0 + TORPEDO_DY - 0x40]) // prettier-ignore
  })

  it('a launcher that spawns another sprite draws it, unverified, naming the number (not a refusal)', () => {
    const r = ok(launcherRom(undefined, launchBytes(0)), routinesOf(launcherRom(undefined, launchBytes(0)))) // prettier-ignore
    expect(r.torpedoId).toBe(0)
    expect(r.torpedoParts.map(p => [p.char, p.attr])).toEqual([[0x24, 0x0a]]) // the cart's id 0 draw
    expect(r.unverified).toEqual(['the sprite the launcher spawns is $00, not Torpedo Ted $44'])
  })

  it("the seed's own RAM cells reach the machine (the torpedo draw reads $0E)", () => {
    const r = ok(launcherRom(), undefined, { ram: { 0x0e: 0x2c } })
    expect(r.torpedoParts[0]!.attr).toBe(0x2c | 0x40 | 0x10)
  })

  it('a slot not in the Normal status is not the spawn (the search is for status 8)', () => {
    const rom = launcherRom(undefined, launchBytes(0x44, 0x30, 0x09))
    expect(run(rom, routinesOf(rom))).toEqual({ ok: false, reason: NO_SPAWN })
  })

  /** The level image as the loader left it, with `plant` applied: what the launcher's clears must wipe. */
  const planted = (rom: RomFile, plant: (w: Uint8Array) => void, over = {}) => {
    const seed = seedOf(rom, over)
    const loaded = Uint8Array.from(seed.loaded!)
    plant(loaded)
    return torpedoLauncher(rom, { ...seed, loaded }, undefined, routinesOf(rom))
  }

  it('a status-8 slot the level image already holds is not the spawn (the status clear is needed)', () => {
    const rom = launcherRom(undefined, launchBytes(0x44, 0x30, 0x09)) // the launch fills slot 0 with status 9
    expect(planted(rom, w => void (w[0x14c8 + 5] = 8))).toEqual({ ok: false, reason: NO_SPAWN })
  })

  it('an extended slot the level image already holds is not the arm (the extended clear is needed)', () => {
    const rom = launcherRom(undefined, launchBytes(0x44, 0x30, 0x08, 0)) // the launch leaves every extended slot empty
    expect(planted(rom, w => void (w[0x170b + 5] = 8))).toEqual({ ok: false, reason: NO_SPAWN })
  })

  it('a leftover shooter timer in the level image is cleared: the launch fires (the timer seed is needed)', () => {
    const rom = launcherRom(undefined, launchBytes(0x44, 0x30, 0x08, 0x08, { gated: true }))
    expect(planted(rom, w => void (w[0x17ab] = 0x10)).ok).toBe(true)
  })

  it('the launch reads its tables through bank 2 (DB = 2)', () => {
    const rom = launcherRom(b => void (b[off(0x02ff00)] = 0x44), launchBytes(0x44, 0x30, 0x08, 0x08, { bankRead: true })) // prettier-ignore
    expect(ok(rom).torpedoId).toBe(0x44)
  })

  it('a shooter at Y >= 256 keeps its high byte: the torpedo is spawned there', () => {
    const r = ok(launcherRom(), undefined, { sprite: { x: SHOOTER.x, y: 0x190 }, camera: { x: CAMERA.x, y: 0x120 } }) // prettier-ignore
    expect(r.torpedo).toEqual({ x: SHOOTER.x + TORPEDO_DX, y: 0x190 + TORPEDO_DY })
  })

  it('a hack whose launch fills the extended slot with another sprite refuses honestly, not as off screen', () => {
    const rom = launcherRom(undefined, launchBytes(0x44, 0x30, 0x08, 0x12))
    const r = run(rom, routinesOf(rom))
    expect(r).toEqual({ ok: false, reason: notTheArm(0x12) })
    expect(!r.ok && r.reason).not.toBe(NO_SPAWN)
  })

  it('a spawned sprite that draws nothing refuses with its reason', () => {
    const rom = launcherRom(undefined, launchBytes(5))
    expect(run(rom, routinesOf(rom))).toEqual({ ok: false, reason: 'the torpedo drew no tile' })
  })

  it('a spawned sprite with no MAIN handler refuses with the runner reason', () => {
    const rom = launcherRom(b => void (b[off(0x018329 + 2 * 0x44) + 1] = 0x00)) // pointer $0000: below the ROM half
    const r = run(rom, routinesOf(rom))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).toMatch(/^MAIN: /)
  })

  // The dispatch bytes the run follows are not the whole check: an ExecutePtr copy that behaves the same but is not the
  // vanilla shape runs, and is reported (the call-target line in torpedoLauncher).
  it('a dispatch call to a differently shaped ExecutePtr runs, unverified, naming the call target', () => {
    const copy = 0x008800
    const dirty = launcherRom(b => {
      b.set([0xea, ...b.subarray(off(0x0086fa), off(0x0086fa) + 27)], off(copy)) // NOP + ExecutePtr
      b.set([copy & 0xff, (copy >> 8) & 0xff, 0x00], off(DISPATCH_AT + 2))
    })
    const r = ok(dirty, routinesOf(launcherRom()))
    expect(r.unverified).toEqual([
      'the shooter dispatch call target could not be verified as the 16-bit ExecutePtr',
    ])
    expect(r.arm).toEqual(ok(launcherRom()).arm)
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
    ['launch', LAUNCH + LAUNCH_SPAN - 4, 'the launcher routine is not the vanilla shape'],
    ['arm', ARM + ARM_SPAN - 4, 'the launcher arm routine is not the vanilla shape'],
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
    expect(ok(dirty, routinesOf(launcherRom())).unverified).toEqual(['the loader route to the shooter is not the vanilla shape']) // prettier-ignore
  })

  // The JSL operand is the call the run follows: a change there lands in code that is not ExecutePtr and refuses.
  it('a changed dispatch call operand refuses, it is not drawn from the wrong code', () => {
    expect(run(launcherRom(b => void (b[off(DISPATCH_AT + 2)]! ^= 1)), routinesOf(launcherRom())).ok).toBe(false) // prettier-ignore
  })

  // A changed table word is what the game would jump to, so it runs, and the dispatch shape check names it (ruling B).
  it('a changed dispatch table word runs where it points, unverified, naming the dispatch', () => {
    const r = ok(launcherRom(b => void (b[off(DISPATCH_AT + 7)]! ^= 1)), routinesOf(launcherRom())) // prettier-ignore
    expect(r.unverified).toContain('the shooter dispatch is not the vanilla shape')
  })

  // The arm is run where the extended-sprite dispatch sends $08 (bank_02.asm:3548, 3558), so a hack that repoints the
  // entry to another routine is run there, and said so; one that moves the dispatch code is not trusted.
  it('a repointed extended-sprite $08 entry runs the new target, unverified, naming it', () => {
    const other = 0x029f00
    const dirty = launcherRom(b => {
      b.set(arm, off(other))
      b.set([other & 0xff, (other >> 8) & 0xff], off(EXT_ENTRY8))
      b[off(other) + 30] = 0x23 // the new arm's attribute byte (palette bits) differs from the vanilla-pointed one's $21
    })
    const r = ok(dirty, routinesOf(launcherRom()))
    expect(r.unverified).toEqual([
      'the extended sprite dispatch sends the arm $08 to $029F00, not the vanilla LauncherArm',
    ])
    expect(r.arm[0]!.palette).not.toBe(ok(launcherRom()).arm[0]!.palette)
  })

  it('an extended-sprite dispatch of another shape is unverified, naming it, and the arm runs at the vanilla address', () => {
    const r = ok(
      launcherRom(b => void (b[off(EXT_AT)]! ^= 1)),
      routinesOf(launcherRom()),
    )
    expect(r.unverified).toEqual(['the extended sprite dispatch is not the vanilla shape, so its entry for the arm $08 could not be read and the arm is run at the vanilla address']) // prettier-ignore
    expect(r.arm).toEqual(ok(launcherRom()).arm)
  })

  it('a level the loader refused has no launcher, and says why', () => {
    const rom = launcherRom()
    expect(torpedoLauncher(rom, { ...seedOf(rom), loaded: undefined, loadRefusal: 'because' })).toEqual({ ok: false, reason: 'because' }) // prettier-ignore
  })

  it('a level the loader refused without a reason says there is no level image', () => {
    const rom = launcherRom()
    expect(torpedoLauncher(rom, { ...seedOf(rom), loaded: undefined })).toEqual({ ok: false, reason: 'no level image' }) // prettier-ignore
  })

  it('a sprite loop that is not the shape the runner knows refuses with its reason', () => {
    const rom = launcherRom(b => void (b[off(0x01808c)] = 0x00)) // PHB becomes BRK
    expect(run(rom)).toEqual({ ok: false, reason: 'sprite loop does not start PHB PHK PLB' })
  })

  it('a HandleSprite that is not the dispatch shape refuses with its reason', () => {
    const rom = launcherRom(b => void (b[off(0x018127)] = 0xea))
    expect(run(rom)).toEqual({ ok: false, reason: 'HandleSprite is not the dispatch shape this reader knows' }) // prettier-ignore
  })

  it('a cart with no ROM bytes reads none of the routines and does not draw', () => {
    const full = launcherRom()
    const seed = seedOf(full)
    const empty = RomFile.fromBytes('empty.sfc', new Uint8Array(0))
    const r = torpedoLauncher(empty, seed, undefined, routinesOf(full))
    expect(r.ok).toBe(false)
    expect(!r.ok && r.reason).not.toBe('no level image')
  })

  it('a part left of the anchor has a negative dx (the 9-bit wrap), one above it a negative dy', () => {
    const r = ok(launcherRom(), undefined, {}) // default anchor: the shooter
    const left = torpedoLauncher(launcherRom(), seedOf(launcherRom()), { x: SHOOTER.x + 0x20, y: SHOOTER.y + 0x20 }, routinesOf(launcherRom())) // prettier-ignore
    if (!left.ok) throw new Error(left.reason)
    expect(left.arm.map(p => [p.dx, p.dy])).toEqual([[ARM_DX - 0x20, ARM_DY - 0x20]])
    expect(left.torpedoParts.map(p => [p.dx, p.dy])).toEqual([[TORPEDO_DX - 0x20, TORPEDO_DY - 0x20]]) // prettier-ignore
    expect(r.arm[0]!.dx).toBe(ARM_DX) // the same run measured from the shooter is positive
  })

  it('an 8 x 8 OAM entry is size 8 (the size bit, not a constant)', () => {
    const at = Array.from(torpedoMain).findIndex((v, i, a) => v === 0xa9 && a[i + 1] === 0x02 && a[i + 2] === 0x85 && a[i + 3] === 0x05) // prettier-ignore
    expect(at).toBeGreaterThan(0)
    const rom = launcherRom(b => void (b[off(TORPEDO_MAIN) + at + 1] = 0x00))
    expect(ok(rom, routinesOf(launcherRom())).torpedoParts.map(p => p.size)).toEqual([8])
  })

  it('an error that is not a refusal is not swallowed', () => {
    const rom = launcherRom()
    const seed = { ...seedOf(rom), mario: undefined } as unknown as ReturnType<typeof seedOf>
    expect(() => torpedoLauncher(rom, seed, undefined, routinesOf(rom))).toThrow(TypeError)
  })

  it('a hard failure is a refusal with its reason', () => {
    expect(run(launcherRom(b => void (b[off(ARM)] = 0x00)))).toEqual({ ok: false, reason: 'BRK executed at $029E3D' }) // prettier-ignore
  })
})

describe('Torpedo Ted launcher on the map (synthetic cart)', () => {
  const rom = launcherRom()
  const sprite: LevelSprite = { index: 3, x: SHOOTER.x / 16, y: SHOOTER.y / 16, spriteId: 0xca, screen: 1, extraBit: false, raw: [0, 0, 0xca], streamOffset: 1 } // prettier-ignore
  const shape = { isVertical: false, screenCount: 4 }
  /** The map view seeds Mario from the loader's image ($94/$96), which the synthetic loader leaves left of the shooter. */
  const seedAt = (cart: RomFile) => withSeed({ ram: { 0x0e: 0x0a } }, levelSeed(cart, LEVEL)) // the cart's torpedo draw reads $0E
  /** The launcher never reruns a sprite: a run that is called fails the test. */
  const noRun = () => {
    throw new Error('the launcher must not run sprite $44 on its own')
  }
  const draw = (cart = rom) => {
    const base = seedAt(cart)
    return interpDrawer(cart, LEVEL, shape, noRun, () => base)(sprite)
  }

  it('is one sprite at the shooter: the arm and the torpedo drawn from the slot the launch filled', () => {
    const res = draw()
    if (!res.ok) throw new Error(res.reason)
    expect(res.anchor).toEqual(SHOOTER)
    // A 16 x 16 piece is four chars; the torpedo is X flipped ($40), so its columns swap. Both at the cart's offsets.
    const quad = (char: number, dx: number, dy: number, flip: boolean) =>
      [[0, 0, 0], [8, 0, 1], [0, 8, 16], [8, 8, 17]].map(([x, y, n]) => [0x400 + char + n!, dx + (flip ? 8 - x! : x!), dy + y!]) // prettier-ignore
    const want = [
      ...quad(0xc1, TORPEDO_DX, TORPEDO_DY, true),
      ...quad(0x100 + ARM_TILE, ARM_DX, ARM_DY, false),
    ]
    expect(res.parts.map(p => [p.charNum, p.dx, p.dy]).sort()).toEqual(want.sort())
    expect(res.parts.filter(p => p.charNum < 0x500).every(p => p.flipX && p.priority === 1)).toBe(
      true,
    )
    expect(res.identity?.spriteId).toBe(0x44)
    // The cart's routines are not the vanilla ones the drawer's guard fingerprints: the draw says so, and still draws (D52).
    expect('unverified' in res && res.unverified).toContain(
      'the launcher routine is not the vanilla shape',
    )
  })

  it('a hack whose launch spawns another sprite draws it, unverified, as that sprite', () => {
    const cart = launcherRom(undefined, launchBytes(0))
    const res = draw(cart)
    if (!res.ok) throw new Error(res.reason)
    expect(res.identity?.spriteId).toBe(0)
    expect('unverified' in res && res.unverified).toContain('the sprite the launcher spawns is $00, not Torpedo Ted $44') // prettier-ignore
  })

  it('drawSprites draws it, not the marker: the bitmap spans the arm and the torpedo', () => {
    const base = seedAt(rom)
    const d = interpDrawer(rom, LEVEL, shape, noRun, () => base)
    const sheet = () => Array.from({ length: 128 }, () => new Uint8Array(64).fill(3))
    const vram = { sp1: sheet(), sp2: sheet(), sp3: sheet(), sp4: sheet() }
    const [dto] = drawSprites(
      [sprite],
      { vram, colors: Array(256).fill([9, 9, 9, 255]) } as never,
      d,
    )
    expect(dto!.status).toBe('drawn')
    // Arm X + 9 .. X + 25, Y - 7 .. Y + 9; torpedo X + 6 .. X + 22, Y + 4 .. Y + 20.
    expect(dto!.box).toEqual({ x0: SHOOTER.x + TORPEDO_DX, y0: SHOOTER.y + ARM_DY, x1: SHOOTER.x + ARM_DX + 16, y1: SHOOTER.y + TORPEDO_DY + 16 }) // prettier-ignore
  })

  it('a launcher the routines cannot run is the marker with the reason (D52)', () => {
    expect(draw(launcherRom(b => void (b[off(LAUNCH)] = 0x60))).ok).toBe(false)
    expect(draw(launcherRom(b => void (b[off(LAUNCH)] = 0x60)))).toEqual({
      ok: false,
      reason: NO_SPAWN,
    })
  })

  it('the refusal names the edge check that stops a launch', () => {
    expect(NO_SPAWN).toContain('$10 / CMP #$20')
    expect(NO_SPAWN).toContain('right')
    expect(NO_SPAWN).toContain('6840-6844') // the Y check
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
      expect(r.torpedoId).toBe(0x44)
      expect(r.arm.map(p => [p.char, p.attr, p.size, p.palette, p.priority, p.dx, p.dy])).toEqual([[0x184, 0x13, 16, 9, 1, 8, -9]]) // prettier-ignore
      expect([r.arm[0]!.ox, r.arm[0]!.oy]).toEqual([x + 8 - camera.x, y - 9 - camera.y])
      // The torpedo as the game draws the launch frame (bank_02.asm:7480-7483, 7544-7590): behind objects
      // ($64 = $10 while $1540 = $30 is set: priority 1), front tile $80 and back tile $82, 16 x 16 each, facing Mario.
      for (const [side, marioX] of [
        ['left', 0],
        ['right', x + 0x40],
      ] as const) {
        const t = torpedoLauncher(rom, withSeed({ sprite: { x, y }, camera, mario: { x: marioX, y: 0x180 } }, base)) // prettier-ignore
        if (!t.ok) throw new Error(`#${s.index}: ${t.reason}`)
        // DATA_02B8F5 (:7541) is $40, $00 by direction; SubHorzPosBnk2 answers 1 for Mario on the left. Not flipped: front piece at dx 0.
        const flip = side === 'right'
        expect(
          t.torpedoParts
            .map(p => [p.char, p.attr, p.size, p.palette, p.priority, p.flipX, p.dx, p.dy])
            .sort(),
        ).toEqual(
          // prettier-ignore
          [[0x180, flip ? 0x53 : 0x13, 16, 9, 1, flip, flip ? 16 : 0, 0], [0x182, flip ? 0x53 : 0x13, 16, 9, 1, flip, flip ? 0 : 16, 0]].sort(), // prettier-ignore
        )
      }
    }
  })

  it('map $011 launcher #0 as the map view seeds it (Mario at the loader start): not flipped, priority 1, back tile $82', () => {
    const rom = RomFile.load(romPath(VANILLA))
    const stream = parseLevelSprites(rom.readUpTo(new SmwRom(rom).getLevelSpritePointer(0x11)!, 0x200)!, false) // prettier-ignore
    const first = stream.find(s => s.spriteId === 0xca)!
    expect(first.index).toBe(0)
    const base = levelSeed(rom, 0x11)
    // The drawer's own Mario: what the loader left in $94/$96 (the seed's loaded image), the same one every sprite is run with.
    expect(base.loaded![0x94]! | (base.loaded![0x95]! << 8)).toBe(24)
    const noRun = () => {
      throw new Error('the launcher is not a rerun of sprite $44')
    }
    const res = interpDrawer(
      rom,
      0x11,
      { isVertical: false, screenCount: 0x20 },
      noRun,
      () => base,
    )(first)
    if (!res.ok) throw new Error(res.reason)
    // The pieces of the torpedo's two 16 x 16 tiles ($80 and $82; the arm's is $84): four chars each.
    const torpedo = res.parts.filter(p => [0x180, 0x182].includes((p.charNum - 0x400) & ~0x11))
    expect(torpedo).toHaveLength(8)
    expect(torpedo.every(p => !p.flipX && p.priority === 1)).toBe(true)
    expect(res.parts.some(p => p.charNum === 0x400 + 0x182)).toBe(true)
    expect(res.parts.every(p => p.priority === 1)).toBe(true)
  })

  it("the vanilla routine fingerprints are the ROM's (the guard is not vacuous)", () => {
    const rom = RomFile.load(romPath(VANILLA))
    expect(routinesOf(rom)).toEqual(VANILLA_LAUNCHER_ROUTINES)
  })

  it('planted: one changed byte in the extended-sprite dispatch span is unverified (opcode, branch and operand bytes)', () => {
    const vanilla = new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)
    const unverified = (mutate: (b: Uint8Array) => void) => {
      const b = Uint8Array.from(vanilla)
      mutate(b)
      const rom = RomFile.fromBytes('planted.sfc', b)
      const stream = parseLevelSprites(rom.readUpTo(new SmwRom(rom).getLevelSpritePointer(0x11)!, 0x200)!, false) // prettier-ignore
      const first = stream.find(s => s.spriteId === 0xca)!
      const [x, y] = [first.x * 16, first.y * 16]
      const camera = { x: Math.max(0, x - 128), y: Math.max(0, Math.min(208, y - 112)) }
      const r = torpedoLauncher(rom, withSeed({ sprite: { x, y }, camera, mario: { x: 0x20, y: 0x180 } }, levelSeed(rom, 0x11))) // prettier-ignore
      return r.ok ? r.unverified : [r.reason]
    }
    const at = (n: number) => off(EXT_DISPATCH) + n
    const MSG = 'the extended sprite dispatch is not the vanilla shape'
    expect(unverified(() => {})).toEqual([])
    for (const n of [0, 1, 4, 10, 17])
      expect(unverified(b => void (b[at(n)]! ^= 1)).join()).toContain(MSG)
  })
})
