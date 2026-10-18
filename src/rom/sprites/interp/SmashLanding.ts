/**
 * SmashLanding.ts -- where the Layer 3 Smash sprite ($89) first puts layer 3, worked out by running
 * the ROM's own code on the core, not by a stored position (#997). The sprite re-sets its X in state 0
 * from GetRand (bank_02.asm:11147-11166) and CODE_00FF61 writes Layer3XPos/YPos from it on the next
 * pass (bank_00.asm:14778-14803), so the landing is a function of how many GetRand calls ran first.
 * RNGCalc is zero at power-on (ClearMemory, bank_00.asm:38-42) and nothing else reseeds it
 * (CODE_01AD07, bank_01.asm:6101-6119), so the chain below reproduces the game's first landing.
 *
 * FIRST_LANDING_SCHEDULE is ONE documented model of the game's order, and a hack-fragility point:
 * a hack that changes the order, adds a GetRand caller before it, or boots another way lands elsewhere.
 *   1. Title map load. GM03 loads the title map by the immediate of LDA #!MainMapLvls+!TitleScreenLevel
 *      (bank_00.asm:2626) and falls into GM11LoadLevel (:2631), whose loader calls GetRand.
 *   2. Target map load: GM11LoadLevel (bank_00.asm:2644-2657) with the RNG the title load left.
 *      (The harness forces the load from the title screen; a title frame does not advance the RNG.)
 *   3. Start-up sprite sweep, CODE_02ACA1 (bank_02.asm:5876-5910), which fills the sprite slots.
 *   4. Sprite pass 1: the sprite loop (CODE_01808C) runs the smasher's state 0.
 *   5. Sprite pass 2: the smasher's main calls CODE_00FF61 first, which writes $22/$24.
 * Evidence scope: the order was checked against GetRand hooks in Mesen on $01F and $1D4 only
 * (1 call in the title load, 4 in the map load, then state 0), one machine, vanilla USA ROM.
 * A step that cannot run refuses the whole result with a reason; nothing is guessed.
 */
import { callSubroutine, describe, Refusal } from '../../cpu/call'
import { OW_ADDR } from '../../OverworldLoader'
import type { RomFile } from '../../RomFile'
import { loadLevelState, RNG_CALC } from './LevelLoader'
import { smwMachine } from './Machine'
import { ENTRY } from './SpriteDispatch'

export const FIRST_LANDING_SCHEDULE = [
  'title map load',
  'target map load',
  'start-up sprite sweep',
  'sprite pass 1',
  'sprite pass 2',
] as const

const SMASH_SPRITE_ID = 0x89
/** The start-up sweep CODE_02ACA1 (bank_02.asm:5876): a JSR entry, DB 2 as its bank. */
const SWEEP = 0x02aca1
const STEP_CAP = 400_000
const LDA_IMM = 0xa9
/** WRAM cells (rammap.asm): the 12 slots' status and number, XLow, XHigh, Layer3XPos/YPos ($22/$24). */
const STATUS = 0x14c8
const NUMBER = 0x9e
const L3_POS = 0x22

export type Landing = { x: number; y: number }
export type LandingResult = { ok: true; landing: Landing | null } | { ok: false; reason: string }

/** The steps, replaceable so a test can check the schedule without the ROM. */
export interface LandingSteps {
  titleMap(rom: RomFile): number | string
  load(rom: RomFile, map: number, rng: number): { wram: Uint8Array; rng: number } | string
  smash(rom: RomFile, wram: Uint8Array): Landing | null | string
}

const rngOf = (w: Uint8Array) => w[RNG_CALC]! | (w[RNG_CALC + 1]! << 8)

/** The title map: the operand of the LDA at GM03LoadTitleScreen, decoded as CODE_05D8A2 does (bank_05.asm:7216-7222). */
function titleMap(rom: RomFile): number | string {
  const at = OW_ADDR.TITLE_LEVEL_LDA_OPERAND
  if (rom.readByte(at - 1) !== LDA_IMM)
    return 'the title screen load is not the shape this reader knows'
  const v = rom.readByte(at)
  if (v === null) return 'the title screen map number is not readable'
  return v >= 0x25 ? v - 0x24 : v
}

function load(rom: RomFile, map: number, rng: number): { wram: Uint8Array; rng: number } | string {
  const l = loadLevelState(rom, map, rng)
  return l.ok ? { wram: l.wram, rng: rngOf(l.wram) } : l.reason
}

/** Steps 3-5 on a loaded map: the landing, or null when the sweep loads no smasher. */
function smash(rom: RomFile, wram: Uint8Array): Landing | null | string {
  const { bus, cpu } = smwMachine(rom, wram)
  const w = bus.wram
  const run = (what: string, entry: number, kind: 'jsr' | 'jsl', db?: number) => {
    const r = callSubroutine(cpu, entry, {
      kind,
      maxSteps: STEP_CAP,
      regs: db === undefined ? {} : { db },
    })
    if (r.kind !== 'returned') throw new Refusal(`${what}: ${describe(r, STEP_CAP)}`)
  }
  try {
    run('the start-up sprite sweep', SWEEP, 'jsr', 2)
    const slots = Array.from({ length: 12 }, (_, i) => i).filter(i => w[STATUS + i] !== 0 && w[NUMBER + i] === SMASH_SPRITE_ID) // prettier-ignore
    if (slots.length === 0) return null
    if (slots.length > 1) return 'several smash sprites are loaded'
    run('the first sprite pass', ENTRY.spriteLoop, 'jsl')
    run('the second sprite pass', ENTRY.spriteLoop, 'jsl')
  } catch (e) {
    if (e instanceof Refusal) return e.message
    throw e
  }
  return { x: w[L3_POS]! | (w[L3_POS + 1]! << 8), y: w[L3_POS + 2]! | (w[L3_POS + 3]! << 8) }
}

export const STOCK_STEPS: LandingSteps = { titleMap, load, smash }

/** Layer3XPos (signed 16-bit) and Layer3YPos the smasher first writes on `map`, or a plain-words reason. */
export function firstLanding(
  rom: RomFile,
  map: number,
  steps: LandingSteps = STOCK_STEPS,
): LandingResult {
  const refuse = (step: (typeof FIRST_LANDING_SCHEDULE)[number], why: string): LandingResult => ({ ok: false, reason: `Layer 3 not drawn yet: ${step} (${why})` }) // prettier-ignore
  const title = steps.titleMap(rom)
  if (typeof title === 'string') return refuse(FIRST_LANDING_SCHEDULE[0], title)
  const first = steps.load(rom, title, 0)
  if (typeof first === 'string') return refuse(FIRST_LANDING_SCHEDULE[0], first)
  const second = steps.load(rom, map, first.rng)
  if (typeof second === 'string') return refuse(FIRST_LANDING_SCHEDULE[1], second)
  const landed = steps.smash(rom, second.wram)
  if (typeof landed === 'string') return refuse(FIRST_LANDING_SCHEDULE[2], landed)
  if (landed === null) return { ok: true, landing: null }
  const signed = (v: number) => (v & 0x8000 ? v - 0x10000 : v)
  return { ok: true, landing: { x: signed(landed.x), y: signed(landed.y) } }
}
