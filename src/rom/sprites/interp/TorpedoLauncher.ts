/**
 * TorpedoLauncher.ts -- sprite $CA, the Torpedo Ted launcher (#985), drawn by the ROM's own
 * shooter code run on the core. No tile, position or attribute is written here.
 *
 * $CA is a shooter, not a sprite: the loader keeps it in the shooter table
 * (id - $C8 = 2, CODE_02A8D4 -> LoadShooter, SMWDisX bank_02.asm:5365-5368, 5744) and draws nothing
 * for it. The game's own frame shows it when the shooter fires:
 * - CODE_02B3AB (bank_02.asm:6827-6833) dispatches the number to LaunchTorpedo (:6835). With
 *   its timer at zero it spawns a normal Torpedo Ted ($44, status 8) at the shooter's position and
 *   the launcher arm, extended sprite $08, at X + 8, Y - 9 (:6891-6902).
 * - LauncherArm (bank_02.asm:3969-4003) draws the arm: tile $84 (the first frame, timer >= $60), 16 x 16.
 *
 * So the preview is the frame at launch. LoadShooter stores ShooterTimer = $10 (bank_02.asm:5776-5777) and
 * the game counts it down before LaunchTorpedo fires, so the timer is seeded with the 0 it holds on the
 * fire frame. The lock is set (SpriteLock = 1), so the arm's and the torpedo's steps are skipped and their
 * spawn frames show (the map view's frame policy, as CastleFlames.ts).
 *
 * The Torpedo Ted is drawn here, in the same machine, from the slot LaunchTorpedo filled: its direction
 * toward Mario ($157C, SubHorzPosBnk2, bank_02.asm:6874-6876) and its launch timer ($1540 = $30, :6878-6879,
 * which TorpedoGfxRt turns into $64 = $10 and the back tile $82, :7480-7483, 7570-7573) are what the
 * game's own draw reads, so the sprite loop (the game's frame, SpriteLock 1) runs on that slot and its OAM
 * is read like the arm's. A rerun of the sprite from a fresh INIT would lose both. Mario is where
 * `seed.mario` puts him ($94/$96 and $D1/$D3), which the map view takes from the level loader's entrance.
 *
 * Owner ruling D52 (option B), as CastleFlames.ts: a routine or call-path part that is not the vanilla
 * one does not stop the run; the result carries `unverified`. What refuses is what cannot draw.
 *
 * Evidence scope: vanilla USA ROM, map $011, one run (docs/sprites/sprite-ca-torpedo-launcher.md).
 */
import { callSubroutine, describe, Refusal } from '../../cpu/call'
import { spanFingerprint } from '../../SubmapFlagGate'
import type { RomFile } from '../../RomFile'
import { bytesAt, shapeMatches } from './Guards'
import { smwMachine } from './Machine'
import {
  checkExecutePtr,
  ENTRY,
  resolveLoop,
  resolvePointer,
  resolveTables,
} from './SpriteDispatch'
import { RAM, type SpritePart } from './SpriteRunner'
import { touchedOamParts } from './CastleFlames'
import type { SpriteSeed } from './SpriteSeed'

/** The shooter number and the ids it leads to: $CA - $C8 (bank_02.asm:5744), Torpedo Ted. */
export const TORPEDO_LAUNCHER_ID = 0xca
const SHOOTER_NUMBER = 2
/** Torpedo Ted (bank_02.asm:6861-6862): what LaunchTorpedo spawns in a vanilla ROM; any other id is reported. */
const VANILLA_SPAWN = 0x44
const ARM_EXT_SPRITE = 0x08

const DISPATCH = 0x02b3ab // CODE_02B3AB: DEC A / JSL ExecutePtr / dw table (bank_02.asm:6827-6832)
const LAUNCH = 0x02b3b6 // LaunchTorpedo
const ARM = 0x029e3d // LauncherArm
/**
 * The extended-sprite loop body, CODE_029B16 (bank_02.asm:3540-3548): LDA ExtSpriteNumber,X / BEQ / LDY SpriteLock / BNE /
 * LDY ExtSpriteMisc176F,X / BEQ / DEC ExtSpriteMisc176F,X / JSL ExecutePtr, then the word table (:3550-3558), whose
 * entry $08 is LauncherArm. The JSL is the last 4 bytes of the shape; the table starts right after it.
 */
const EXT_DISPATCH = 0x029b16
const EXT_DISPATCH_SHAPE = [0xbd, 0x0b, 0x17, 0xf0, 0xfa, 0xa4, 0x9d, 0xd0, 0x08, 0xbc, 0x6f, 0x17, 0xf0, 0x03, 0xde, 0x6f, 0x17, 0x22, null, null, null] // prettier-ignore
const EXT_TABLE = EXT_DISPATCH + EXT_DISPATCH_SHAPE.length

/** SMW_U.sym WRAM cells (rammap.asm:1777-1794). */
const W = {
  shooterNumber: 0x1783,
  shooterYLow: 0x178b,
  shooterYHigh: 0x1793,
  shooterXLow: 0x179b,
  shooterXHigh: 0x17a3,
  shooterTimer: 0x17ab,
  extNumber: 0x170b,
  extSlots: 10,
  spriteLock: 0x9d,
} as const

/** The path from the loader to the dispatch, as bytes (null: an operand that does not matter). */
const PATH: { what: string; at: number; want: (number | null)[] }[] = [
  // CODE_02A8D4 (bank_02.asm:5365-5368): CMP #$C9 / BCC / JSR LoadShooter / BRA
  { what: 'the loader route to the shooter is not the vanilla shape', at: 0x02a8d4, want: [0xc9, 0xc9, 0x90, null, 0x20, null, null, 0x80, null] }, // prettier-ignore
  // CODE_02B3AB and its pointer table's second word (bank_02.asm:6827-6832)
  { what: 'the shooter dispatch is not the vanilla shape', at: DISPATCH, want: [0x3a, 0x22, null, null, null, null, null, 0xb6, 0xb3] }, // prettier-ignore
]

/** SHA-256 of each whole routine (174 and 69 bytes, ending in RTS). */
export interface LauncherRoutines {
  launch: string
  arm: string
}
export const VANILLA_LAUNCHER_ROUTINES: LauncherRoutines = {
  launch: 'e0962dc7d4565ad6480cdf5d97422c7917875f697a80e41e54631097c87dd2f3',
  arm: 'b4e8ba768bd56d5de75a028061a684286b5871605714d7f6674d0aa1a9869350',
}
const LAUNCH_LENGTH = 174
const ARM_LENGTH = 69

/** LaunchTorpedo returns without spawning when the shooter is off screen vertically (Y minus the camera's high byte nonzero, SMWDisX bank_02.asm:6840-6844) or horizontally (:6845-6849), or within $10 px of either side edge (the +$10 / CMP #$20 check on an 8-bit sum, :6850-6856). */
export const NO_SPAWN = 'the launcher spawned no torpedo and arm (the shooter is off screen vertically, bank_02.asm:6840-6844, or horizontally, :6845-6849, or within 16 px of the left or right edge of the screen: the +$10 / CMP #$20 check, :6850-6856)' // prettier-ignore

/** A hack whose launch fills the extended slot with something other than the arm: not drawn, since no routine here runs it. */
export const notTheArm = (n: number) => `the launcher spawned extended sprite $${n.toString(16).toUpperCase().padStart(2, '0')}, not its arm $08, which this preview does not draw` // prettier-ignore

export type LauncherResult =
  | {
      ok: true
      /** Where the game put the spawned sprite (level pixels). */
      torpedo: { x: number; y: number }
      /** The spawned sprite's number, as the slot holds it. */
      torpedoId: number
      /** The spawned sprite's OAM entries from the game's own frame; dx/dy are relative to `anchor`. */
      torpedoParts: SpritePart[]
      /** The arm's OAM entries; dx/dy are relative to `anchor`. */
      arm: SpritePart[]
      unverified: string[]
    }
  | { ok: false; reason: string }

/**
 * The launcher's frame at launch for a shooter at `seed.sprite`, in `seed`'s level state and camera.
 * `anchor` is the point the arm's dx/dy are measured from.
 */
export function torpedoLauncher(
  rom: RomFile,
  seed: SpriteSeed,
  anchor: { x: number; y: number } = seed.sprite,
  routines: LauncherRoutines = VANILLA_LAUNCHER_ROUTINES,
): LauncherResult {
  if (!seed.loaded) return { ok: false, reason: seed.loadRefusal ?? 'no level image' }
  const unverified = PATH.filter(c => !shapeMatches(bytesAt(rom, c.at, c.want.length), c.want)).map(c => c.what) // prettier-ignore
  const callee = bytesAt(rom, DISPATCH + 2, 3)
  if (!callee || !checkExecutePtr(rom, [callee]).ok) unverified.push('the shooter dispatch call target could not be verified as the 16-bit ExecutePtr') // prettier-ignore
  // The extended sprite $08 is run where the game's own dispatch sends it (bank_02.asm:3548, 3558), not at a fixed address.
  const extShape = shapeMatches(bytesAt(rom, EXT_DISPATCH, EXT_DISPATCH_SHAPE.length), EXT_DISPATCH_SHAPE) // prettier-ignore
  const extCallee = bytesAt(rom, EXT_DISPATCH + EXT_DISPATCH_SHAPE.length - 3, 3)
  const extWord = bytesAt(rom, EXT_TABLE + 2 * ARM_EXT_SPRITE, 2)
  let armAt = ARM
  if (!extShape || !extCallee || !checkExecutePtr(rom, [extCallee]).ok || !extWord) {
    unverified.push('the extended sprite dispatch is not the vanilla shape, so its entry for the arm $08 could not be read and the arm is run at the vanilla address') // prettier-ignore
  } else {
    armAt = 0x020000 | extWord[0]! | (extWord[1]! << 8)
    if (armAt !== ARM) unverified.push(`the extended sprite dispatch sends the arm $08 to $${armAt.toString(16).toUpperCase().padStart(6, '0')}, not the vanilla LauncherArm`) // prettier-ignore
  }
  const sha = (at: number, n: number) => spanFingerprint(Uint8Array.from(bytesAt(rom, at, n) ?? []))
  if (sha(LAUNCH, LAUNCH_LENGTH) !== routines.launch)
    unverified.push('the launcher routine is not the vanilla shape')
  if (sha(ARM, ARM_LENGTH) !== routines.arm)
    unverified.push('the launcher arm routine is not the vanilla shape')
  try {
    const { bus, cpu } = smwMachine(rom, seed.loaded)
    const w = bus.wram
    for (const [k, v] of Object.entries(seed.ram)) w[Number(k)] = v
    const w16 = (off: number, v: number) =>
      void ((w[off] = v & 0xff), (w[off + 1] = (v >> 8) & 0xff))
    w16(RAM.camX, seed.camera.x)
    w16(RAM.camY, seed.camera.y)
    for (const off of [RAM.marioXNext, RAM.marioXNow]) w16(off, seed.mario.x)
    for (const off of [RAM.marioYNext, RAM.marioYNow]) w16(off, seed.mario.y)
    // The shooter alone fires: every sprite and extended slot is free, so the game's searches pick the first.
    w.fill(0, RAM.status, RAM.status + 12)
    w.fill(0, W.extNumber, W.extNumber + W.extSlots)
    w.fill(0, W.shooterNumber, W.shooterTimer + 8)
    w[W.shooterNumber] = SHOOTER_NUMBER
    w[W.shooterXLow] = seed.sprite.x & 0xff
    w[W.shooterXHigh] = seed.sprite.x >> 8
    w[W.shooterYLow] = seed.sprite.y & 0xff
    w[W.shooterYHigh] = seed.sprite.y >> 8
    w[W.spriteLock] = 1
    const touched = new Set<number>()
    bus.onWramWrite = off => touched.add(off)
    // The game enters both from bank 2, so the tables they read go through DB = 2.
    const run = (entry: number, regs: { a?: number; x: number }, kind: 'jsr' | 'jsl' = 'jsr') => {
      const r = callSubroutine(cpu, entry, { kind, maxSteps: 50_000, regs: { db: 2, ...regs } }) // prettier-ignore
      if (r.kind !== 'returned') throw new Refusal(describe(r, 50_000)!)
    }
    // Both loops store the slot they are on in CurSpriteProcess ($15E9, bank_02.asm:2870, 6808); LauncherArm reads it; LaunchTorpedo takes its shooter index from the X it is called with.
    w[RAM.curSprite] = 0
    run(DISPATCH, { a: SHOOTER_NUMBER, x: 0 })
    // Every slot was free, so a slot in status 8 (Normal, bank_02.asm:6859-6860) is what LaunchTorpedo spawned, whatever number a hack gave it.
    const spawned = Array.from({ length: 12 }, (_, i) => i).find(i => w[RAM.status + i] === 8)
    // The first extended slot LaunchTorpedo filled (every one was free, so any nonzero number is its).
    const ext = Array.from({ length: W.extSlots }, (_, i) => i).find(i => w[W.extNumber + i] !== 0)
    if (spawned === undefined || ext === undefined) return { ok: false, reason: NO_SPAWN }
    if (w[W.extNumber + ext] !== ARM_EXT_SPRITE) return { ok: false, reason: notTheArm(w[W.extNumber + ext]!) } // prettier-ignore
    const torpedo = {
      x: w[RAM.spriteXLow + spawned]! | (w[RAM.xHigh + spawned]! << 8),
      y: w[RAM.spriteYLow + spawned]! | (w[RAM.yHigh + spawned]! << 8),
    }
    // The torpedo: the game's own sprite loop over the slot it filled, locked (draw only), then its OAM.
    const id = w[RAM.spriteNumber + spawned]!
    if (id !== VANILLA_SPAWN) unverified.push(`the sprite the launcher spawns is $${id.toString(16).toUpperCase().padStart(2, '0')}, not Torpedo Ted $44`) // prettier-ignore
    const loop = resolveLoop(rom)
    if (!loop.ok) return { ok: false, reason: loop.reason }
    const tables = resolveTables(rom, loop.handle)
    if (!tables.ok) return { ok: false, reason: tables.reason }
    const main = resolvePointer(rom, tables.tables.mainTable, id)
    if (!main.ok) return { ok: false, reason: `MAIN: ${main.reason}` }
    touched.clear()
    run(ENTRY.spriteLoop, { x: 0 }, 'jsl')
    const at = (x9: number, y: number) => {
      const rel = (((x9 - (anchor.x - seed.camera.x)) % 512) + 512) % 512
      const dy = (y - (anchor.y - seed.camera.y)) & 0xff
      return { dx: rel > 255 ? rel - 512 : rel, dy: dy > 127 ? dy - 256 : dy }
    }
    const torpedoParts = touchedOamParts(w, touched, at)
    if (torpedoParts.length === 0) return { ok: false, reason: 'the torpedo drew no tile' }
    touched.clear()
    w[RAM.curSprite] = ext
    run(armAt, { x: ext })
    const arm = touchedOamParts(w, touched, at)
    // A launcher without its hand is not the game's frame; it still draws (D52), and says so.
    if (arm.length === 0) unverified.push('the launcher arm drew no tile')
    return { ok: true, torpedo, torpedoId: id, torpedoParts, arm, unverified }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message }
    throw e
  }
}
