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
  Machine,
  runOnce,
  SPAWN_SHORT,
  type RunOptions,
  type SpriteModel,
  type SpritePart,
} from './SpriteRunner'
import { SPRITE_SEED, withSeed, type SpriteSeed } from './SpriteSeed'

/** The Wave Eerie the spawner makes. */
const SPAWNED_SPRITE = 0x39
const SPAWNER_LENGTH = 97
/**
 * The loader route at $02:A88C (bank_02.asm:5312-5318) is checked by STRUCTURE, never by hash: its 12 bytes hold under 24
 * unknown ones (the BA fingerprint minimum, 2026-10-18), and a digest joined to another span would blame the wrong
 * routine. Each part is compared on its own against a named constant, offsets from the start of the route.
 */
const ROUTE_AT = 0x02a88c
export const EERIES_ROUTE = 'the loader route to the Eerie spawner'
const OP_CMP_IMM = 0xc9
const OP_BNE = 0xd0
const OP_DEY = 0x88
const OP_STY_DP = 0x84
/** The sprite number the route compares against: this command's own id. */
const SPRITE_ID = 0xde
/** Direct page $03: where the spawner reads the entry's data offset (bank_02.asm:6270). */
const DP_DATA_OFFSET = 0x03
/** CMP #$DE, BNE, PHY, PHX, DEY, STY $03, JSR (bank_02.asm:5312-5318). */
const AT = { cmp: 0, id: 1, bne: 2, dey: 6, sty: 7, dp: 8, jsr: 9 }
/** SubHorzPosBnk2 (bank_02.asm:524-534): 18 bytes, under 24 unknown, so it is checked by what it does (`horzPosBehaves`). */
const HORZ_POS = 0x02848d
export const EERIES_HORZ = 'the horizontal distance routine'
/** The opcode of a JSR, compared on its own (never inside a stored byte array) to find the call's operand. */
const OP_JSR = 0x20
/** The loader's `JSR Load5Eeries` (bank_02.asm:5318): its opcode, and the operand that names the spawner. */
const LOADER_CALL = ROUTE_AT + AT.jsr

/**
 * The spawner the loader calls: the JSR operand at $02:A895 (bank 2), what the ROM holds, so a repointed call runs the
 * routine it names. With no JSR there the call was replaced and there is no spawner to name: null, never a vanilla
 * address (the caller refuses in plain words).
 */
export function spawnerEntry(rom: RomFile): number | null {
  const call = bytesAt(rom, LOADER_CALL, 3)
  return call?.[0] === OP_JSR ? 0x020000 | call[1]! | (call[2]! << 8) : null
}

/** How many Eeries Load5Eeries tries to spawn (the loop from 4 down to 0, bank_02.asm:6278-6313). */
export const EERIES_COUNT = 5
const EERIES = EERIES_COUNT

/** SHA-256 of the spawner (97 bytes, ending in RTS: ~96 unknown); the tables it reads are NOT part. */
export interface EeriesRoutines {
  spawner: string
}
export const VANILLA_EERIES_ROUTINES: EeriesRoutines = {
  spawner: 'b277ad92a80e34c68aba19f8d69b55e478d6ca17b6d1c731f98356c53de9c7b3',
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

/**
 * True when the loader still has the shape the spawner call rests on: CMP #$DE, BNE, DEY, STY $03 and a JSR, each checked
 * alone. Not checked, because nothing the spawner reads depends on them: the BNE's offset and the PHY / PHX / PLX / PLY /
 * BRA around the call. A loader without this shape may hold $20 as an operand where the JSR opcode was, so the address
 * read from it would not be a spawner (a repointed JSR operand on an intact route is).
 */
export function eeriesRouteIntact(rom: RomFile): boolean {
  const at = (k: keyof typeof AT) => bytesAt(rom, ROUTE_AT + AT[k], 1)?.[0]
  return (
    at('cmp') === OP_CMP_IMM &&
    at('id') === SPRITE_ID &&
    at('bne') === OP_BNE &&
    at('dey') === OP_DEY &&
    at('sty') === OP_STY_DP &&
    at('dp') === DP_DATA_OFFSET &&
    at('jsr') === OP_JSR
  )
}

/**
 * True when SubHorzPosBnk2 on the core answers Y = 1 for Mario left of the sprite and 0 otherwise (what the spawner reads
 * to pick each Eerie's X speed), over pairs on both sides, equal, and across a 256 and a 512 px boundary. A routine that
 * cannot run counts as not behaving. Run, not hashed: 18 bytes are under 24 unknown.
 */
export function horzPosBehaves(rom: RomFile): boolean {
  const pairs: [mario: number, sprite: number][] = [[100, 832], [832, 100], [500, 500], [255, 256], [256, 255], [1000, 300]] // prettier-ignore
  try {
    return pairs.every(([mx, sx]) => {
      const m = new Machine(rom, withSeed({ sprite: { x: sx, y: 0x80 }, mario: { x: mx } }, SPRITE_SEED), SPAWNED_SPRITE) // prettier-ignore
      m.cpu.y = 0xff // so a routine that never sets Y is not read as 0 by chance
      m.call(HORZ_POS, 'jsr', HORZ_POS >>> 16)
      return (m.cpu.y & 0xff) === (mx < sx ? 1 : 0)
    })
  } catch {
    return false
  }
}

/** `unverified` names each routine or call-path part that is not the vanilla shape (empty when all match). */
export function eeriesGate(
  rom: RomFile,
  routines: EeriesRoutines = VANILLA_EERIES_ROUTINES,
): string[] {
  const out: string[] = []
  if (!eeriesRouteIntact(rom)) out.push(EERIES_ROUTE)
  if (!horzPosBehaves(rom)) out.push(EERIES_HORZ)
  // With no JSR there is no spawner to hash; the route check above already names the changed call.
  const entry = spawnerEntry(rom)
  if (entry !== null && spanFingerprint(Uint8Array.from(bytesAt(rom, entry, SPAWNER_LENGTH) ?? [])) !== routines.spawner) out.push('the Eerie spawner') // prettier-ignore
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
  if (!eeriesRouteIntact(rom))
    return { ok: false, reason: `${EERIES_ROUTE} is not the shape this reader knows, so the Eerie spawner cannot be found`, unverified } // prettier-ignore
  const routine = spawnerEntry(rom)
  if (routine === null)
    return { ok: false, reason: 'the loader no longer calls a spawner for the five Eeries (no JSR where it called one), so there is nothing to run', unverified } // prettier-ignore
  const inputs = { 0x00: e.x & 0xff, 0x01: (e.x >> 8) & 0xff, 0x02: e.index, 0x03: e.streamOffset }
  const placed: PlacedEerie[] = []
  let why = ''
  let missing = 0
  for (let n = 0; n < EERIES; n++) {
    const m = run(rom, SPAWNED_SPRITE, { ...seed, mainPasses: passes }, { spawn: { inputs, routine, nth: n } }) // prettier-ignore
    if (m.refusal?.startsWith(SPAWN_SHORT)) {
      missing++
      continue
    }
    const pass = m.chosen === undefined ? undefined : m.passes[m.chosen]
    if (!m.anchor || !pass || !m.spawnPos) {
      why ||= m.refusal ?? m.emptyReason ?? 'drew no tile'
      continue
    }
    // D137: drawn where the spawner put the Eerie (spawnPos), not where the frames before the drawn pass moved it. The run's
    // parts are relative to the pass's origin; their offset from the Eerie as drawn is kept, and the Eerie is put back on its
    // spawn spot, then everything is re-anchored to the entry.
    const [sx, sy] = [m.spawnPos.x, m.spawnPos.y]
    const [ox, oy] = [pass.origin.x - pass.pos.x + sx - e.x, pass.origin.y - pass.pos.y + sy - e.y]
    placed.push({
      x: sx,
      y: sy,
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
