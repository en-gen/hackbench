/**
 * TorpedoLauncher.ts -- sprite $CA, the Torpedo Ted launcher (#985), drawn by the ROM's own
 * shooter code run on the core. No tile, position or attribute is written here.
 *
 * $CA is a shooter, not a sprite: the loader keeps it in the shooter table
 * (id - $C8 = 2, CODE_02A8D4 -> LoadShooter, SMWDisX bank_02.asm:5365-5368, 5744) and draws nothing
 * for it. The game's own frame shows it when the shooter fires:
 * - CODE_02B3AB (bank_02.asm:6830-6832) dispatches the number to LaunchTorpedo (:6835). With
 *   its timer at zero it spawns a normal Torpedo Ted ($44, status 8) at the shooter's position and
 *   the launcher arm, extended sprite $08, at X + 8, Y - 9 (:6891-6902).
 * - LauncherArm (bank_02.asm:3969-4003) draws the arm: tile $84 (the first frame, timer >= $60), 16 x 16.
 *
 * So the preview is the frame at launch: the timer is left at the zero the shooter table holds before
 * its first fire (the shooter's own spawn does not set it, bank_02.asm:5744-5760), the lock is set
 * (SpriteLock = 1), so the arm's step is skipped and its spawn frame shows (the map view's frame
 * policy, as CastleFlames.ts). The Torpedo Ted itself is the spawned sprite: the caller draws
 * it with the ordinary sprite run at the position this returns.
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
import { checkExecutePtr } from './SpriteDispatch'
import { RAM, type SpritePart } from './SpriteRunner'
import { touchedOamParts } from './CastleFlames'
import type { SpriteSeed } from './SpriteSeed'

/** The shooter number and the ids it leads to: $CA - $C8 (bank_02.asm:5744), Torpedo Ted. */
export const TORPEDO_LAUNCHER_ID = 0xca
const SHOOTER_NUMBER = 2
const TORPEDO_TED = 0x44
const ARM_EXT_SPRITE = 0x08

const DISPATCH = 0x02b3ab // CODE_02B3AB: DEC A / JSL ExecutePtr / dw table (bank_02.asm:6830-6836)
const LAUNCH = 0x02b3b6 // LaunchTorpedo
const ARM = 0x029e3d // LauncherArm

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
  { what: 'the loader route to the shooter', at: 0x02a8d4, want: [0xc9, 0xc9, 0x90, null, 0x20, null, null, 0x80, null] }, // prettier-ignore
  // CODE_02B3AB and its pointer table's second word (bank_02.asm:6830-6836)
  { what: 'the shooter dispatch', at: DISPATCH, want: [0x3a, 0x22, null, null, null, null, null, 0xb6, 0xb3] }, // prettier-ignore
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

export type LauncherResult =
  | {
      ok: true
      /** Where the game put the spawned Torpedo Ted (level pixels). */
      torpedo: { x: number; y: number }
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
  if (!callee || !checkExecutePtr(rom, [callee]).ok) unverified.push('the shooter dispatch call target') // prettier-ignore
  const sha = (at: number, n: number) => spanFingerprint(Uint8Array.from(bytesAt(rom, at, n) ?? []))
  if (sha(LAUNCH, LAUNCH_LENGTH) !== routines.launch) unverified.push('the launcher routine')
  if (sha(ARM, ARM_LENGTH) !== routines.arm) unverified.push('the launcher arm routine')
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
    const run = (entry: number, regs: { a?: number; x: number }) => {
      const r = callSubroutine(cpu, entry, { kind: 'jsr', maxSteps: 50_000, regs: { db: 2, ...regs } }) // prettier-ignore
      if (r.kind !== 'returned') throw new Refusal(describe(r, 50_000)!)
    }
    // Both loops store the slot they are on in CurSpriteProcess ($15E9, bank_02.asm:4370, 6808); the routines reload X from it.
    w[RAM.curSprite] = 0
    run(DISPATCH, { a: SHOOTER_NUMBER, x: 0 })
    const spawned = Array.from({ length: 12 }, (_, i) => i).find(i => w[RAM.status + i] === 8 && w[RAM.spriteNumber + i] === TORPEDO_TED) // prettier-ignore
    const ext = Array.from({ length: W.extSlots }, (_, i) => i).find(i => w[W.extNumber + i] === ARM_EXT_SPRITE) // prettier-ignore
    if (spawned === undefined || ext === undefined)
      return { ok: false, reason: 'the launcher spawned no torpedo and arm (off screen or too near the left edge)' } // prettier-ignore
    const torpedo = {
      x: w[RAM.spriteXLow + spawned]! | (w[RAM.xHigh + spawned]! << 8),
      y: w[RAM.spriteYLow + spawned]! | (w[RAM.yHigh + spawned]! << 8),
    }
    touched.clear()
    w[RAM.curSprite] = ext
    run(ARM, { x: ext })
    const arm = touchedOamParts(w, touched, (x9, y) => {
      const rel = (((x9 - (anchor.x - seed.camera.x)) % 512) + 512) % 512
      const dy = (y - (anchor.y - seed.camera.y)) & 0xff
      return { dx: rel > 255 ? rel - 512 : rel, dy: dy > 127 ? dy - 256 : dy }
    })
    // A launcher without its hand is not the game's frame; it still draws (D52), and says so.
    if (arm.length === 0) unverified.push('the launcher arm drew no tile')
    return { ok: true, torpedo, arm, unverified }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message }
    throw e
  }
}
