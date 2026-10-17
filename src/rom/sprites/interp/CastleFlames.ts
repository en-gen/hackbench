/**
 * CastleFlames.ts -- the candle flames sprite $E6 puts on Layer 2, drawn by the
 * ROM's own cluster code run on the core (#894). No position, tile or attribute
 * is written here: the spawn routine and the draw routine make them.
 *
 * - Spawn: CODE_02AA6C (SMWDisX bank_02.asm:5582-5598; DATA_02AA68 at 5579-5580), reached from
 *   CODE_02AAC0 on id $E6 (bank_02.asm:5631-5637): four cluster sprites of type 5.
 * - Draw: CODE_02FA16 (bank_02.asm:16230-16279), the cluster dispatch's type 5
 *   entry (dw table after the JSL at CODE_02F821, bank_02.asm:15962-15972). It
 *   draws each flame at its position minus Layer2XPos/Layer2YPos, so with both at
 *   zero the OAM position IS the flame's Layer 2 position, wrapped to a byte.
 *
 * SpriteLock ($9D) is set for the draw: the routine then skips its random
 * flicker step (bank_02.asm:16231-16232) and shows the first frame, which is the
 * map view's frame policy. A flame's Y is $F0 in Layer 2 space; the sprite loop's
 * "offscreen" fill (Y = $F0) is not applied, so it is not mistaken for one.
 *
 * Evidence scope: vanilla USA ROM, map $01F and the other maps with $E6, one run
 * each (docs/sprites/sprite-e6-castle-flames.md).
 *
 * Viewers draw, they do not blank (rom-interpretation.md, owner ruling D52, option B): a routine
 * or call-path byte that is not the vanilla one does NOT stop the run. The ROM's own code is still
 * run, at the vanilla entries, and the result carries `unverified` naming each part that differs.
 * We do not follow a hacked call path (that would be an emulator, out of scope); the note says the
 * flames come from the routines as they stand, not from a verified path to them. What still
 * refuses is what cannot draw: no level image, a run that does not return, and a GetRand that is
 * not the known shape but is actually executed (below).
 */
import { mirror } from '../../addressing'
import { callSubroutine, describe, Refusal } from '../../cpu/call'
import { spanFingerprint } from '../../SubmapFlagGate'
import type { RomFile } from '../../RomFile'
import { bytesAt, shapeMatches } from './Guards'
import { smwMachine } from './Machine'
import { checkExecutePtr, checkGetRand, ENTRY } from './SpriteDispatch'
import { RAM, type SpritePart } from './SpriteRunner'
import { levelSeed } from './LevelLoader'
import type { SpriteSeed } from './SpriteSeed'

const SPAWN = 0x02aa6c
const DRAW = 0x02fa16
/** The cluster dispatch's type-5 entry (6th dw of the table at $02:F825) and the $E6 branch to the spawn. */
const DISPATCH_TYPE5 = { at: 0x02f82f, want: [0x16, 0xfa] }
const E6_BRANCH = { at: 0x02aac9, want: [0xc9, 0xe6, 0xf0, 0x9f] } // CMP #$E6 / BEQ CODE_02AA6C
/**
 * The path from the level's sprite list to the draw, read as bytes (a null matches any byte: an operand
 * that names a RAM cell or a table the run does not depend on). Each is a call site or entry a hack can
 * divert while the routines stay byte-identical (rom-interpretation.md, "Existing is not the same as reached").
 */
const PATH: { what: string; at: number; want: (number | null)[] }[] = [
  // CODE_02A8C0 (bank_02.asm:5348-5355): CMP #$E1 / BCC / PHX / PHY / DEY / STY $03 / JSR CODE_02AAC0
  { what: 'the loader route to the sprite spawn', at: 0x02a8c0, want: [0xc9, 0xe1, 0x90, 0x0c, 0xda, 0x5a, 0x88, 0x84, 0x03, 0x20, 0xc0, 0xaa] }, // prettier-ignore
  // CODE_02AAC0 (bank_02.asm:5631-5635): LDY #1 / STY ActivateClusterSprite / CMP #$E4 / BEQ
  { what: 'the $E6 spawn entry', at: 0x02aac0, want: [0xa0, 0x01, 0x8c, null, null, 0xc9, 0xe4, 0xf0, null] }, // prettier-ignore
  { what: 'the $E6 branch to the flame spawn', ...E6_BRANCH },
  // CODE_02F808 and CODE_02F810 (bank_02.asm:15942-15958): PHB PHK PLB JSR / PLB RTL, then the cluster countdown over 20
  // slots that calls CODE_02F821 for a non-zero ClusterSpriteNumber ($1892). PHK PLB is why the draw runs with DB = 2.
  { what: 'the cluster loop', at: 0x02f808, want: [0x8b, 0x4b, 0xab, 0x20, 0x10, 0xf8, 0xab, 0x6b, 0xa2, 0x13, 0x8e, null, null, 0xbd, 0x92, 0x18, 0xf0, 0x03, 0x20, 0x21, 0xf8, 0xca, 0x10, 0xf2] }, // prettier-ignore
  // CODE_02F821 (bank_02.asm:15962-15963): JSL ExecutePtr; its target is checked to be the 16-bit ExecutePtr below.
  { what: 'the cluster dispatch call', at: 0x02f821, want: [0x22, null, null, null] },
  { what: 'the cluster dispatch entry for type 5', ...DISPATCH_TYPE5 },
]

/** SHA-256 of the whole routine (33 and 110 bytes, ending in RTS); the data tables they read are NOT part of it. */
export interface FlameRoutines {
  spawn: string
  draw: string
}
export const VANILLA_FLAME_ROUTINES: FlameRoutines = {
  spawn: '53bb50d4f6e9d3227864671530ed91f48d30d45cf86ca293fe26db047437fc36',
  draw: 'ac4cb045da54628d8e0bae9ea55d73d460b18c8514dba7ba6c4028c320bfe6b8',
}

const CLUSTER_NUMBER = 0x1892
const CLUSTER_SLOTS = 4
const LAYER2_POS = 0x1e
const SPRITE_LOCK = 0x9d

/** `unverified` names each routine or call-path part that is not the vanilla shape (empty when all match). */
export type FlamesResult =
  { ok: true; parts: SpritePart[]; unverified: string[] } | { ok: false; reason: string }

/**
 * The OAM entries a run wrote a tile to, as parts; `place` gives dx/dy from the entry's 9-bit X and Y
 * (shared with TorpedoLauncher.ts, whose arm is measured from the shooter instead).
 */
export function touchedOamParts(
  w: Uint8Array,
  touched: ReadonlySet<number>,
  place: (x9: number, y: number) => { dx: number; dy: number },
): SpritePart[] {
  const parts: SpritePart[] = []
  for (let i = 0; i < RAM.oamEntries; i++) {
    const b = RAM.oam + i * 4
    if (!touched.has(b + 2)) continue
    const attr = w[b + 3]!
    const hi = w[RAM.oamSize + i]!
    const x9 = w[b]! | ((hi & 1) << 8)
    parts.push({
      oam: i,
      char: w[b + 2]! | ((attr & 1) << 8),
      size: hi & 2 ? 16 : 8,
      palette: 8 + ((attr >> 1) & 7),
      priority: (attr >> 4) & 3,
      flipX: !!(attr & 0x40),
      flipY: !!(attr & 0x80),
      ...place(x9, w[b + 1]!),
      attr,
      ox: x9,
      oy: w[b + 1]!,
    })
  }
  return parts
}

/**
 * The flames as OAM parts in Layer 2 space (`ox`/`oy`, and `dx`/`dy` equal to them), for the level
 * `seed` belongs to. `seed` is `levelSeed`'s: its loaded image is the level's state, and its
 * cluster numbers stay cleared for every other sprite's run (#809); only these runs set them.
 */
export function castleFlames(
  rom: RomFile,
  seed: SpriteSeed,
  routines: FlameRoutines = VANILLA_FLAME_ROUTINES,
): FlamesResult {
  if (!seed.loaded) return { ok: false, reason: seed.loadRefusal ?? 'no level image' }
  const unverified = PATH.filter(c => !shapeMatches(bytesAt(rom, c.at, c.want.length), c.want)).map(c => c.what) // prettier-ignore
  const callee = bytesAt(rom, 0x02f822, 3)
  if (!callee || !checkExecutePtr(rom, [callee]).ok) unverified.push('the cluster dispatch call target') // prettier-ignore
  const sha = (at: number, n: number) => spanFingerprint(Uint8Array.from(bytesAt(rom, at, n) ?? []))
  if (sha(SPAWN, 33) !== routines.spawn) unverified.push('the flame spawn routine')
  if (sha(DRAW, 110) !== routines.draw) unverified.push('the flame draw routine')
  // The draw's `JSL GetRand` is inside the hashed routine and SpriteLock is 1, so GetRand is normally never
  // reached; a changed GetRand that does not run must not stop the flames. It refuses only when fetched.
  const rand = checkGetRand(rom)
  try {
    const { bus, cpu } = smwMachine(rom, seed.loaded)
    const w = bus.wram
    for (const [k, v] of Object.entries(seed.ram)) w[Number(k)] = v
    w.fill(0, LAYER2_POS, LAYER2_POS + 4)
    w[SPRITE_LOCK] = 1
    const guard = bus.onInstruction
    bus.onInstruction = (addr, op) => {
      guard?.(addr, op)
      if (!rand.ok && mirror(addr) === mirror(ENTRY.getRand)) throw new Refusal(rand.reason)
    }
    const touched = new Set<number>()
    bus.onWramWrite = off => touched.add(off)
    // The game enters both from bank 2 (PHK PLB in the cluster loop), so its tables read through DB = 2.
    const run = (entry: number, x?: number) => {
      const r = callSubroutine(cpu, entry, { kind: 'jsr', maxSteps: 20_000, regs: { db: 2, ...(x === undefined ? {} : { x }) } }) // prettier-ignore
      if (r.kind !== 'returned') throw new Refusal(describe(r, 20_000)!)
    }
    run(SPAWN)
    for (let x = 0; x < CLUSTER_SLOTS; x++) {
      if (w[CLUSTER_NUMBER + x] !== 5) continue
      run(DRAW, x)
    }
    const parts = touchedOamParts(w, touched, (x9, y) => ({ dx: x9, dy: y }))
    return { ok: true, parts, unverified }
  } catch (e) {
    if (e instanceof Refusal) return { ok: false, reason: e.message }
    throw e
  }
}

/** The flames of `level`, from the ROM's own level state. */
export const castleFlamesOf = (rom: RomFile, level: number): FlamesResult =>
  castleFlames(rom, levelSeed(rom, level))
