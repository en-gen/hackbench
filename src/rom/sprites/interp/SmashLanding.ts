/**
 * SmashLanding.ts -- where the Layer 3 Smash sprite ($89) first puts layer 3, worked out by running
 * the ROM's own code on the core, not by a stored position (#997). Why: the sprite's X comes from
 * GetRand (bank_02.asm:11158-11163), so the landing depends on how many GetRand calls ran since
 * power-on. The call chain, evidence scope and blind spots are in docs/rom/map-data-mechanics.md
 * ("Layer 3 under a smash sprite").
 *
 * FIRST_LANDING_SCHEDULE is ONE model of the game's order and a HACK-FRAGILITY POINT: a hack that
 * changes the order or adds a GetRand caller lands elsewhere, and the loader's shape gate cannot
 * see it. A step that cannot run refuses the whole result with a reason; nothing is guessed.
 */
import { callSubroutine, describe, Refusal } from '../../cpu/call'
import { OW_ADDR } from '../../OverworldLoader'
import type { RomFile } from '../../RomFile'
import { loadLevelState, RNG_CALC } from './LevelLoader'
import { smwMachine } from './Machine'
import { ENTRY } from './SpriteDispatch'

/** The order the game runs these in; one model, verified on $01F and $1D4 only (see the doc). */
export const FIRST_LANDING_SCHEDULE = [
  'title map load',
  'target map load',
  'start-up sprite sweep',
  'sprite pass 1',
  'sprite pass 2',
] as const

export const SMASH_SPRITE_ID = 0x89
/** The start-up sweep CODE_02ACA1 (bank_02.asm:5876): a JSR entry, DB 2 as its bank. */
const SWEEP = 0x02aca1
// Per run of the sweep or of one sprite pass. Vanilla $01F took about 5,300 steps for the sweep and about 1,200
// for a pass (one run, one machine), so this is far above need; it only stops a hacked loop that never returns.
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

/** The load step over a loader (the level loader; a test passes its own). */
export const loadWith =
  (loader: typeof loadLevelState): LandingSteps['load'] =>
  (rom, map, rng) => {
    const l = loader(rom, map, rng)
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
    const slot = slots[0]!
    for (const pass of ['first', 'second']) {
      run(`the ${pass} sprite pass`, ENTRY.spriteLoop, 'jsl')
      // An erased or replaced smasher leaves the loader's $22/$24, which is not a landing.
      if (w[STATUS + slot] === 0 || w[NUMBER + slot] !== SMASH_SPRITE_ID)
        return `the smash sprite did not survive the ${pass} sprite pass`
    }
  } catch (e) {
    if (e instanceof Refusal) return e.message
    throw e
  }
  // Y is read as the code left it, not cross-checked: CODE_00FF61 adds ScreenShakeYOffset (bank_00.asm:14798-14800),
  // zero here because the shake timer starts at a slam (bank_02.asm:11197), long after pass 2.
  return { x: w[L3_POS]! | (w[L3_POS + 1]! << 8), y: w[L3_POS + 2]! | (w[L3_POS + 3]! << 8) }
}

export const STOCK_STEPS: LandingSteps = { titleMap, load: loadWith(loadLevelState), smash }

/** Layer3XPos (signed 16-bit) and Layer3YPos the smasher first writes on `map`, or a plain-words reason. */
export function firstLanding(
  rom: RomFile,
  map: number,
  steps: LandingSteps = STOCK_STEPS,
): LandingResult {
  const refuse = (step: (typeof FIRST_LANDING_SCHEDULE)[number], why: string): LandingResult => ({ ok: false, reason: `the smasher's first landing could not be worked out (${step}: ${why})` }) // prettier-ignore
  const title = steps.titleMap(rom)
  if (typeof title === 'string') return refuse(FIRST_LANDING_SCHEDULE[0], title)
  const first = steps.load(rom, title, 0)
  if (typeof first === 'string') return refuse(FIRST_LANDING_SCHEDULE[0], first)
  const second = steps.load(rom, map, first.rng)
  if (typeof second === 'string') return refuse(FIRST_LANDING_SCHEDULE[1], second)
  const landed = steps.smash(rom, second.wram)
  // The smash step names its own failure (sweep, pass 1, pass 2, several smashers).
  if (typeof landed === 'string')
    return { ok: false, reason: `the smasher's first landing could not be worked out (${landed})` }
  if (landed === null) return { ok: true, landing: null }
  const signed = (v: number) => (v & 0x8000 ? v - 0x10000 : v)
  return { ok: true, landing: { x: signed(landed.x), y: signed(landed.y) } }
}
