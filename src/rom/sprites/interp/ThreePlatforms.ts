/**
 * ThreePlatforms.ts -- sprite $E0, a run-once loader command that spawns three Grey Platforms on Chain ($A3)
 * (the $E0 issue). The ROM's own spawner runs on the core and each platform is then drawn by the ordinary sprite
 * runner, INIT included; no position, angle or chain is written here. Same shape as FiveEeries.ts.
 *
 * - Caller: CODE_02A89C (SMWDisX bank_02.asm:5325-5331) hands the spawner the entry's screen-boundary X in $00/$01,
 *   its list index in $02 and the offset of its first byte in $03.
 * - Spawner: Load3Platforms (bank_02.asm:6211-6251) reads that byte through SpriteDataPtr (high nibble Y low, bit 0
 *   Y high), then spawns three: status $01 (INIT), number $A3, InitSpriteTables, X and Y shared, and per platform
 *   an angle from DATA_02AF2D (into $1602) and a second value from DATA_02AF30 (into $151C), both read from the ROM. Only the first
 *   spawn gets the list index (6244-6247). Unlike $DE the platforms are status 1, so their INIT runs.
 * - The platforms stay where the spawner put them; INIT and MAIN place the chain and each platform's pieces.
 *
 * Evidence scope: derived from the ROM's own code, no hardware comparison (docs/sprites/sprite-e0-chain-platforms.md).
 * Viewers draw, they do not blank (D52): a routine or call-path part that is not the vanilla one is named in
 * `unverified` and the spawner the loader calls still runs; only what cannot draw refuses.
 */
import { spanFingerprint } from '../../SubmapFlagGate'
import type { RomFile } from '../../RomFile'
import { bytesAt } from './Guards'
import { runSpawnedChildren } from './SpawnedChildren'
import { runOnce, type RunOptions, type SpriteModel, type SpritePart } from './SpriteRunner'
import type { SpriteSeed } from './SpriteSeed'

/** Load3Platforms, and the Grey Platform on Chain it spawns. */
export const LOAD_3_PLATFORMS = 0x02af33
const SPAWNED_SPRITE = 0xa3
const SPAWNER_LENGTH = 84
export const PLATFORM_COUNT = 3
/** The loader's route at $02:A89C starts CMP #$E0 (bank_02.asm:5325). Checked by structure, not by hash: 12 bytes hold under 24 unknown ones (the fingerprint minimum), so a digest would be brute-forceable. */
const LOADER_ROUTE = { what: 'the loader route to the platform spawner', at: 0x02a89c }
/** Opcodes and operands the loader route is checked on, each compared on its own (never as a stored run of bytes). */
const OP_CMP_IMM = 0xc9
const OP_BNE = 0xd0
const OP_PHY = 0x5a
const OP_PHX = 0xda
const OP_DEY = 0x88
const OP_STY_DP = 0x84
const OP_JSR = 0x20
const OP_PLY = 0x7a
const OP_PLX = 0xfa
const OP_BRA = 0x80
/** The sprite number the route compares against: this sprite's own id. */
const SPRITE_ID = 0xe0
/** Direct page $03: where the spawner reads the entry's data offset (bank_02.asm:6212). */
const DP_DATA_OFFSET = 0x03
/**
 * Offsets in the route from its start (bank_02.asm:5325-5335): CMP #$E0, BNE, PHY, PHX, DEY, STY $03, JSR, PLX, PLY,
 * BRA back to the loop head (CODE_02A89A, 2 bytes before the route), then CODE_02A8AC, the next case, which starts with a compare.
 */
const AT = { cmp: 0, id: 1, bne: 2, bneTo: 3, push1: 4, push2: 5, dey: 6, sty: 7, dp: 8, jsr: 9, pop1: 12, pop2: 13, bra: 14, braTo: 15, next: 16 } // prettier-ignore
/** Where the BRA must land, relative to the route's start. */
const LOOP_HEAD = -2
/** The loader's `JSR Load3Platforms` (bank_02.asm:5331): its opcode, and the operand that names the spawner. */
const LOADER_CALL = LOADER_ROUTE.at + AT.jsr

/**
 * The spawner the loader calls: the JSR operand (bank 2), what the ROM holds, so a repointed call runs the routine it
 * names. With no JSR there the call was replaced and there is no spawner to name: null, never a vanilla address.
 */
export function spawnerEntry(rom: RomFile): number | null {
  const call = bytesAt(rom, LOADER_CALL, 3)
  return call?.[0] === OP_JSR ? 0x020000 | call[1]! | (call[2]! << 8) : null
}

/**
 * SHA-256 of the spawner (84 bytes, ending in RTS), one digest, nothing masked: well over 24 unknown bytes. The two
 * tables the spawner reads are data and NOT part. The loader route is checked by structure (`loaderRouteIntact`).
 */
export interface PlatformRoutines {
  spawner: string
}
export const VANILLA_PLATFORM_ROUTINES: PlatformRoutines = {
  spawner: '1d4bd4577349469b955d8ff0f36f58280c4da2b4f3101d78a815b42a88ec513d',
}

export interface PlatformEntry {
  /** The entry's X and Y in px, the spawner's $00/$01 and (for the anchor) its data byte. */
  x: number
  y: number
  /** Index in the sprite list ($02) and the offset of the entry's first byte ($03). */
  index: number
  streamOffset: number
  /** The entry's map position in px when `x` is the vertical map's Y boundary (as for the Eeries). Defaults to (x, y). */
  at?: { x: number; y: number }
}

export type PlatformsResult =
  | { ok: true; parts: SpritePart[]; unverified: string[]; spawned: number; notes: string[] }
  | { ok: false; reason: string; none?: true; unverified: string[] }

/**
 * True when every instruction of the loader's route from the compare to the loop's next case is the one the spawner
 * call rests on, each checked alone: CMP #$E0, BNE (its offset read from the ROM must land on the next case), the two
 * pushes (either order) with the pops in the reverse order, DEY, STY $03, JSR, the BRA (its offset must land on the loop
 * head) and the next case's compare. A BRA planted anywhere in it would skip the JSR, so none of it is left unchecked.
 * Not hashed: 12 to 17 bytes hold under 24 unknown.
 */
export function loaderRouteIntact(rom: RomFile): boolean {
  const at = (k: keyof typeof AT) => bytesAt(rom, LOADER_ROUTE.at + AT[k], 1)?.[0]
  const rel = (k: 'bneTo' | 'braTo', from: number) => {
    const v = at(k)
    return v === undefined ? NaN : AT[k] + 1 + (v < 0x80 ? v : v - 0x100) - from
  }
  const [push1, push2, pop1, pop2] = [at('push1'), at('push2'), at('pop1'), at('pop2')]
  const pushes = (push1 === OP_PHY && push2 === OP_PHX) || (push1 === OP_PHX && push2 === OP_PHY)
  const pops = (pop1 === OP_PLX && pop2 === OP_PLY && push1 === OP_PHY) || (pop1 === OP_PLY && pop2 === OP_PLX && push1 === OP_PHX) // prettier-ignore
  return (
    at('cmp') === OP_CMP_IMM &&
    at('id') === SPRITE_ID &&
    at('bne') === OP_BNE &&
    rel('bneTo', 0) === AT.next &&
    pushes &&
    pops &&
    at('dey') === OP_DEY &&
    at('sty') === OP_STY_DP &&
    at('dp') === DP_DATA_OFFSET &&
    at('jsr') === OP_JSR &&
    at('bra') === OP_BRA &&
    rel('braTo', 0) === LOOP_HEAD &&
    at('next') === OP_CMP_IMM
  )
}

/** `unverified` names each routine or call-path part that is not the vanilla shape (empty when all match). */
export function platformsGate(
  rom: RomFile,
  routines: PlatformRoutines = VANILLA_PLATFORM_ROUTINES,
): string[] {
  const out: string[] = []
  const sha = (at: number, n: number) => spanFingerprint(Uint8Array.from(bytesAt(rom, at, n) ?? []))
  if (!loaderRouteIntact(rom)) out.push(LOADER_ROUTE.what)
  // With no JSR there is no spawner to hash; the route check above already names the changed call.
  const entry = spawnerEntry(rom)
  if (entry !== null && sha(entry, SPAWNER_LENGTH) !== routines.spawner) out.push('the platform spawner') // prettier-ignore
  return out
}

/** The three platforms of one $E0 entry as OAM parts, `dx`/`dy` relative to the entry. */
export function threePlatforms(
  rom: RomFile,
  seed: SpriteSeed,
  e: PlatformEntry,
  routines: PlatformRoutines = VANILLA_PLATFORM_ROUTINES,
  passes = 1,
  run: (rom: RomFile, id: number, seed: SpriteSeed, opts?: RunOptions) => SpriteModel = runOnce,
): PlatformsResult {
  const unverified = platformsGate(rom, routines)
  // A loader that no longer has this route may hold an operand where the JSR opcode was, so the address read from it
  // is not a spawner to run (a repointed JSR operand on an intact route is).
  if (!loaderRouteIntact(rom))
    return { ok: false, reason: `${LOADER_ROUTE.what} is not the shape this reader knows, so the platform spawner cannot be found`, unverified } // prettier-ignore
  const routine = spawnerEntry(rom)
  if (routine === null)
    return { ok: false, reason: 'the loader no longer calls a spawner for the three platforms (no JSR where it called one), so there is nothing to run', unverified } // prettier-ignore
  const spec = { sprite: SPAWNED_SPRITE, count: PLATFORM_COUNT, routine, spawnFrame: true }
  const { children, missing, why } = runSpawnedChildren(rom, seed, e, spec, passes, run)
  if (children.length === 0)
    return { ok: false, reason: why || `the spawner made none of the ${PLATFORM_COUNT} platforms`, ...(missing === PLATFORM_COUNT ? { none: true as const } : {}), unverified } // prettier-ignore
  const undrawn = PLATFORM_COUNT - missing - children.length
  const notes = why ? [`${undrawn} ${undrawn === 1 ? 'platform' : 'platforms'} did not draw: ${why}`] : [] // prettier-ignore
  return {
    ok: true,
    parts: children.flatMap(c => c.parts),
    unverified,
    spawned: PLATFORM_COUNT - missing,
    notes,
  }
}
