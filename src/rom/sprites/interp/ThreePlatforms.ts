/**
 * ThreePlatforms.ts -- sprite $E0, a run-once loader command that spawns three Grey Platforms on Chain ($A3)
 * (the $E0 issue). The ROM's own spawner runs on the core and each platform is then drawn by the ordinary sprite
 * runner, INIT included; no position, angle or chain is written here. Same shape as FiveEeries.ts.
 *
 * - Caller: CODE_02A89C (SMWDisX bank_02.asm:5325-5331) hands the spawner the entry's screen-boundary X in $00/$01,
 *   its list index in $02 and the offset of its first byte in $03.
 * - Spawner: Load3Platforms (bank_02.asm:6211-6251) reads that byte through SpriteDataPtr (high nibble Y low, bit 0
 *   Y high), then spawns three: status $01 (INIT), number $A3, InitSpriteTables, X and Y shared, and per platform
 *   an angle from DATA_02AF2D ($00,$AA,$54 into $1602) and DATA_02AF30 ($00,$00,$01 into $151C). Only the first
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
import { jsrTarget, runSpawnedChildren } from './SpawnedChildren'
import { runOnce, type RunOptions, type SpriteModel, type SpritePart } from './SpriteRunner'
import type { SpriteSeed } from './SpriteSeed'

/** Load3Platforms, and the Grey Platform on Chain it spawns. */
export const LOAD_3_PLATFORMS = 0x02af33
const SPAWNED_SPRITE = 0xa3
const SPAWNER_LENGTH = 84
export const PLATFORM_COUNT = 3
/** The loader's route, 12 bytes at $02:A89C: CMP #$E0 / BNE / PHY / PHX / DEY / STY $03 / JSR Load3Platforms (bank_02.asm:5325-5331). Kept as a fingerprint, not as bytes. */
const LOADER_ROUTE = { what: 'the loader route to the platform spawner', at: 0x02a89c, length: 12 }
/** The loader's `JSR Load3Platforms` (bank_02.asm:5331). */
const LOADER_CALL = 0x02a8a5

/** The spawner the loader calls (the JSR operand, bank 2), so a repointed call runs the routine it names; the vanilla entry when there is no JSR. */
export function spawnerEntry(rom: RomFile): number {
  return jsrTarget(rom, LOADER_CALL, LOAD_3_PLATFORMS)
}

/** SHA-256 of the spawner (84 bytes, ending in RTS) and of the loader route (12); the two tables the spawner reads are data and NOT part. */
export interface PlatformRoutines {
  spawner: string
  loaderRoute: string
}
export const VANILLA_PLATFORM_ROUTINES: PlatformRoutines = {
  spawner: '1d4bd4577349469b955d8ff0f36f58280c4da2b4f3101d78a815b42a88ec513d',
  loaderRoute: '9d36e7ee9e18df10b419797ee95e79d453d5c73af7c9b505a6f04297620ba0f4',
}

export interface PlatformEntry {
  /** The entry's X and Y in px, the spawner's $00/$01 and (for the anchor) its data byte. */
  x: number
  y: number
  /** Index in the sprite list ($02) and the offset of the entry's first byte ($03). */
  index: number
  streamOffset: number
}

export type PlatformsResult =
  | { ok: true; parts: SpritePart[]; unverified: string[]; spawned: number; notes: string[] }
  | { ok: false; reason: string; none?: true; unverified: string[] }

/** `unverified` names each routine or call-path part that is not the vanilla shape (empty when all match). */
export function platformsGate(
  rom: RomFile,
  routines: PlatformRoutines = VANILLA_PLATFORM_ROUTINES,
): string[] {
  const out: string[] = []
  const sha = (at: number, n: number) => spanFingerprint(Uint8Array.from(bytesAt(rom, at, n) ?? []))
  if (sha(LOADER_ROUTE.at, LOADER_ROUTE.length) !== routines.loaderRoute)
    out.push(LOADER_ROUTE.what)
  if (sha(spawnerEntry(rom), SPAWNER_LENGTH) !== routines.spawner) out.push('the platform spawner')
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
  const spec = { sprite: SPAWNED_SPRITE, count: PLATFORM_COUNT, routine: spawnerEntry(rom) }
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
