/**
 * FiveEeries.ts -- sprite $DE, a run-once loader command that spawns five Wave Eeries (#1015). The
 * ROM's own spawner runs on the core and each Eerie is then drawn by the ordinary sprite runner;
 * no position, speed or frame is written here.
 *
 * - Caller: CODE_02A88C (SMWDisX bank_02.asm:5312-5322) hands the spawner the entry's screen-boundary X
 *   in $00/$01, its list index in $02 and the offset of its first byte in $03.
 * - Spawner: Load5Eeries (bank_02.asm:6269-6313) reads that byte through SpriteDataPtr: its high nibble is
 *   Y low, bit 0 is Y high (6270-6277). Five spawns, X offsets from EerieGroupDispXLo/Hi (6254-6258), each
 *   status $08 and number $39 with no INIT (6284-6288), speed and state from the tables (6260-6267).
 *   SubHorzPosBnk2 (bank_02.asm:524-534) picks the X speed by Mario's side (6309-6311). Only the first
 *   spawn gets the list index (6305-6308), which is why a hardware capture links one Eerie per placement.
 * - Room: Load5Eeries stops at the first call with no free slot (6281-6282). FindFreeSlotRt searches the map's
 *   slot range from SpriteSlotMax down and never tests SpriteSlotStart itself (5523-5539; tables 5182-5200), so a
 *   range of four slots (memory setting 11: $11D, $1E8, $1E9) spawns FOUR Eeries from an empty table, the last of
 *   the five (X offset -$20) never exists. Other live sprites can take slots too; the map view starts from empty ones.
 * - Frame policy: pass 0 of the runner, with Mario at the map's start, as for every sprite. A hardware
 *   capture is mid-level, so only the capture-linked Eerie can be compared, after the same number of frames.
 *
 * Evidence scope: vanilla USA ROM, maps $021, $11D, $1E8, $1E9 (docs/sprites/sprite-de-five-eeries.md).
 * Viewers draw, they do not blank (owner ruling D52, option B): a routine or call-path byte that is not the
 * vanilla one is named in `unverified` and the spawner the loader calls still runs; only what cannot draw refuses.
 */
import { spanFingerprint } from '../../SubmapFlagGate'
import type { RomFile } from '../../RomFile'
import { bytesAt } from './Guards'
import {
  runOnce,
  SPAWN_SHORT,
  type RunOptions,
  type SpriteModel,
  type SpritePart,
} from './SpriteRunner'
import type { SpriteSeed } from './SpriteSeed'

/** Load5Eeries, and the Wave Eerie it spawns. */
export const LOAD_5_EERIES = 0x02af9d
const SPAWNED_SPRITE = 0x39
const SPAWNER_LENGTH = 97
const HORZ_POS = { at: 0x02848d, length: 18 }
/** The loader's compare, branch and call to the spawner (bank_02.asm:5312-5318): 12 bytes, hashed as one span. */
const LOADER_ROUTE = { what: 'the loader route to the Eerie spawner', at: 0x02a88c, length: 12 }
/** The opcode of a JSR; the only literal byte read here, to find the call's operand. */
const JSR = 0x20
/** The loader's `JSR Load5Eeries` (bank_02.asm:5318): its opcode, and the operand that names the spawner. */
const LOADER_CALL = 0x02a895

/**
 * The spawner the loader calls: the JSR operand at $02:A895 (bank 2), what the ROM holds, so a repointed call runs the
 * routine it names. With no JSR there (the call was replaced) the vanilla entry runs; the route check names it (D52).
 */
export function spawnerEntry(rom: RomFile): number {
  const call = bytesAt(rom, LOADER_CALL, 3)
  return call?.[0] === JSR ? 0x020000 | call[1]! | (call[2]! << 8) : LOAD_5_EERIES
}

/** How many Eeries Load5Eeries tries to spawn (the loop from 4 down to 0, bank_02.asm:6278-6313). */
export const EERIES_COUNT = 5
const EERIES = EERIES_COUNT

/** SHA-256 of the spawner (97 bytes, ending in RTS), of SubHorzPosBnk2 (18) and of the loader's route (12); the tables they read are NOT part. */
export interface EeriesRoutines {
  spawner: string
  horzPos: string
  route: string
}
export const VANILLA_EERIES_ROUTINES: EeriesRoutines = {
  route: '27b4d1a1a894fc763e51f9f4dc7cefa0a89bc641986285cba69d7ed65f2c2159',
  spawner: 'b277ad92a80e34c68aba19f8d69b55e478d6ca17b6d1c731f98356c53de9c7b3',
  horzPos: 'a2e15a2fa227d056e8956c36f8ba970f01ed7732ba4cbf560c56916682ea5b5f',
}

/** The sprite's list entry as the loader hands it to the spawner. */
export interface EeriesEntry {
  /** The entry's X in px (the spawner's $00/$01). */
  x: number
  /** The entry's Y in px, for the anchor only: the spawner takes Y from the data byte. */
  y: number
  /** Index in the sprite list ($02). */
  index: number
  /** Offset of the entry's first byte in the list ($03). */
  streamOffset: number
}

export interface PlacedEerie {
  /** The Eerie's map position at the drawn pass, in px. */
  x: number
  y: number
  parts: SpritePart[]
}

export type EeriesResult =
  | {
      ok: true
      eeries: PlacedEerie[]
      parts: SpritePart[]
      unverified: string[]
      /** Eeries the spawner made. Fewer than five is the game's own answer when the map's slot range has no room (see FiveEeries.ts head). */
      spawned: number
      /** Eeries that were spawned and did not draw, with the reason. */
      notes: string[]
    }
  | {
      ok: false
      reason: string
      /** True when the spawner made no Eerie at all (every call found no free slot). */
      none?: true
      unverified: string[]
    }

/** `unverified` names each routine or call-path part that is not the vanilla shape (empty when all match). */
export function eeriesGate(
  rom: RomFile,
  routines: EeriesRoutines = VANILLA_EERIES_ROUTINES,
): string[] {
  const out: string[] = []
  const sha = (at: number, n: number) => spanFingerprint(Uint8Array.from(bytesAt(rom, at, n) ?? []))
  if (sha(LOADER_ROUTE.at, LOADER_ROUTE.length) !== routines.route) out.push(LOADER_ROUTE.what)
  if (sha(spawnerEntry(rom), SPAWNER_LENGTH) !== routines.spawner) out.push('the Eerie spawner')
  if (sha(HORZ_POS.at, HORZ_POS.length) !== routines.horzPos)
    out.push('the horizontal distance routine')
  return out
}

/**
 * The five Eeries of one $DE entry as OAM parts, `dx`/`dy` relative to the entry's position. `seed` is the
 * level's (its loaded image holds SpriteDataPtr); `passes` is how many MAIN passes each Eerie is run for, the
 * first drawing one is shown. Each Eerie is its own run of the ROM's spawner (a fresh machine), the nth
 * spawned sprite drawn alone, so the five do not add to each other's OAM.
 */
export function fiveEeries(
  rom: RomFile,
  seed: SpriteSeed,
  e: EeriesEntry,
  routines: EeriesRoutines = VANILLA_EERIES_ROUTINES,
  passes = 1,
  run: (rom: RomFile, id: number, seed: SpriteSeed, opts?: RunOptions) => SpriteModel = runOnce,
): EeriesResult {
  const unverified = eeriesGate(rom, routines)
  const inputs = { 0x00: e.x & 0xff, 0x01: (e.x >> 8) & 0xff, 0x02: e.index, 0x03: e.streamOffset }
  const placed: PlacedEerie[] = []
  let why = ''
  let missing = 0
  for (let n = 0; n < EERIES; n++) {
    const m = run(rom, SPAWNED_SPRITE, { ...seed, mainPasses: passes }, { spawn: { inputs, routine: spawnerEntry(rom), nth: n } }) // prettier-ignore
    if (m.refusal?.startsWith(SPAWN_SHORT)) {
      missing++
      continue
    }
    const pass = m.chosen === undefined ? undefined : m.passes[m.chosen]
    if (!m.anchor || !pass) {
      why ||= m.refusal ?? m.emptyReason ?? 'drew no tile'
      continue
    }
    // The run's parts are relative to the Eerie's own position when the passes began; re-anchor them to the entry.
    const [ox, oy] = [m.anchor.x - e.x, m.anchor.y - e.y]
    placed.push({
      x: pass.pos.x,
      y: pass.pos.y,
      parts: pass.parts.map(p => ({ ...p, dx: p.dx + ox, dy: p.dy + oy })),
    })
  }
  if (placed.length === 0)
    return {
      ok: false,
      reason: why || `the spawner made none of the ${EERIES} Eeries`,
      ...(missing === EERIES ? { none: true as const } : {}),
      unverified,
    }
  // A shortfall of spawns is the game's own (the map's slot range, FindFreeSlotRt bank_02.asm:5523-5539); one that
  // spawned and did not draw is told.
  const notes = why ? [`${EERIES - missing - placed.length} Eeries did not draw: ${why}`] : []
  return {
    ok: true,
    eeries: placed,
    parts: placed.flatMap(p => p.parts),
    unverified,
    spawned: EERIES - missing,
    notes,
  }
}
