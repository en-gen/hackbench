/**
 * RevealSearch.ts -- finds the sprites that draw nothing until something happens, and what happens.
 *
 * The at-rest run (D139 D) shows a sprite as the game would on its first frames with Mario at the level's entrance.
 * A sprite whose code draws only on a condition (an invisible mushroom that waits for Mario's box, a mole that
 * waits for his distance, a block a switch turns on) draws nothing there. This reruns the same sprite through the
 * same runner with Mario and the switches changed, and reports the first change that makes it draw. Nothing here is
 * keyed on a sprite id or on what a sprite becomes: the ROM's own sprite loop runs whatever handler the sprite
 * reaches, and only a drawn frame counts.
 *
 * No shell imports: the caller gives the rerun, so the node side's seed and run options stay its own.
 */
import type { SpriteModel } from './SpriteRunner'
import { withSeed, type SeedOverride, type SpriteSeed } from './SpriteSeed'

/** What made a hidden sprite draw; the node side words it. Order is the search order (D142). */
export type RevealCondition =
  'mario-at-sprite' | 'mario-left' | 'mario-right' | 'more-frames' | 'p-switch' | 'on-off'

export type RevealResult =
  /** Drew at rest and in every probe: nothing changes. */
  | { status: 'visible' }
  /** The sprite draws nothing under some probe: `model` is the first drawn frame of the first condition that draws. */
  | { status: 'hidden'; condition: RevealCondition; model: SpriteModel }
  /**
   * Hidden, and no condition within the bound drew it. `drewAtRest`: the real-start run did draw it, and that
   * picture stands (the caller draws it in the screen door and claims no condition).
   */
  | { status: 'unrevealed'; drewAtRest: boolean }
  /** Not searched: the run was refused or the sprite removed itself, so there is nothing to reveal. */
  | { status: 'skipped'; reason: string }

/** Passes the "more frames" condition runs: 4 times the default 64, so a slow timer shows and a never-drawing sprite stops. */
export const MORE_FRAMES = 256

/**
 * Mario's state in every probe: small, standing, on foot, not on Yoshi, free of any entrance animation (the loaded
 * image holds the animation the level starts with, and contact is refused during one, bank_01.asm:5411-5413). His
 * position is fed to the sprite's code and never drawn. $19 Powerup, $71 PlayerAnimation, $72 PlayerInAir,
 * $73 PlayerDucking, $187A PlayerRidingYoshi (SMWDisX rammap.asm).
 */
export const MARIO_STATE: Readonly<Record<number, number>> = {
  0x19: 0,
  0x71: 0,
  0x72: 0,
  0x73: 0,
  0x187a: 0,
}

/** A nonzero BluePSwitchTimer ($14AD): only "active" matters to a sprite that tests it. */
const P_SWITCH_ON = 0xb0

/**
 * Mario's X minus the sprite's, tried to find a run that draws nothing. The mole tests only the LOW byte of that
 * distance (SubHorizPos, bank_01.asm:6124-6129; the mole adds $60 and compares with $C0, bank_01.asm:13341-13346), so
 * it draws for 192 of every 256 values and hides in a 64 wide band that repeats every 256 px. Eight steps of $20 cover
 * the low byte with no gap wider than 32, so the band cannot fall between two steps; the two far values
 * (low byte $80, on both sides) cover a sprite that only needs Mario nearby.
 */
export const DISTANCES = [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0, 0x180, -0x180] as const

/** The nearest block either side, in pixels: "just left" and "just right" of the sprite. */
const BESIDE = 16

/**
 * Mario's Y is the top of his 32 px body and a small Mario's box starts 20 px down it (GetMarioClipping, measured on
 * the core: box y = Y + 20, height 12), so standing on the sprite's row puts his box 16 px below a 16 px sprite's.
 * 16 above the sprite's Y overlaps it.
 */
const STANDING_ON = -16

/**
 * The cells a probe changes: Mario's position (Next $94-$97, Now $D1-$D4), his fixed state, the P-switch timer and
 * the ON/OFF cell. A run that never read one before writing it cannot react to any probe.
 */
const PROBED_CELLS: ReadonlySet<number> = new Set([
  0x94,
  0x95,
  0x96,
  0x97,
  0xd1,
  0xd2,
  0xd3,
  0xd4,
  0x14ad,
  0x14af,
  ...Object.keys(MARIO_STATE).map(Number),
])

/** Whether a run completed and drew at least one tile of the sprite's own on its chosen pass. */
export function drew(m: SpriteModel): boolean {
  return !m.refusal && m.chosen !== undefined && (m.passes[m.chosen]?.parts.length ?? 0) > 0
}

/**
 * Looks for what makes a hidden sprite draw. `first` is the at-rest run of `seed`; `run` reruns the sprite with a
 * changed seed and must count only the sprite's own OAM writes (`ownOamOnly`, D106A: a sprite it creates is not its
 * picture). `probe` is true for the hidden check, which only asks whether the sprite draws, so the rerun may stop at
 * its first drawn pass; the search's own reruns run whole, as their passes are the sprite's frames. A refused rerun
 * counts as not drawing, never as a finding.
 */
export function findReveal(
  seed: SpriteSeed,
  first: SpriteModel,
  run: (seed: SpriteSeed, probe: boolean) => SpriteModel,
): RevealResult {
  if (first.refusal) return { status: 'skipped', reason: first.refusal }
  if (first.emptyReason?.startsWith('INIT erased'))
    return { status: 'skipped', reason: first.emptyReason }
  const at = (dx: number): SeedOverride => ({
    marioMain: { x: Math.max(0, seed.sprite.x + dx), y: Math.max(0, seed.sprite.y + STANDING_ON) },
    ram: MARIO_STATE,
  })
  const rerun = (o: SeedOverride, probe = false) => run(withSeed(o, seed), probe)
  // Blank under any probe (even if the real start drew it) means hidden; the first blank ends the check.
  // `first.inputs` (RunOptions.trackInputs) lists the cells it read before writing; none probed means every probe
  // would repeat it, so a sprite that drew needs none. Without the list (not tracked) the probes run.
  const blind = first.inputs !== undefined && !first.inputs.some(c => PROBED_CELLS.has(c))
  const hidden =
    !drew(first) ||
    (!blind &&
      DISTANCES.some(d => {
        const m = rerun(at(d), true)
        return !m.refusal && !drew(m)
      }))
  if (!hidden) return { status: 'visible' }
  const onOff = (seed.loaded?.[0x14af] ?? seed.onOff ?? 0) ^ 1
  const tries: [RevealCondition, SeedOverride][] = [
    ['mario-at-sprite', at(0)],
    ['mario-left', at(-BESIDE)],
    ['mario-right', at(BESIDE)],
    ['more-frames', { mainPasses: MORE_FRAMES, ram: MARIO_STATE }],
    ['p-switch', { pSwitch: P_SWITCH_ON, ram: MARIO_STATE }],
    ['on-off', { onOff, ram: MARIO_STATE }],
  ]
  // Mario's position is what a probe changed. The other three reruns start from the real Mario, so for a sprite that
  // drew there they would only draw the same frame again and call that a reveal.
  const startedDrawn = drew(first)
  for (const [condition, o] of startedDrawn ? tries.slice(0, 3) : tries) {
    const model = rerun(o)
    if (drew(model)) return { status: 'hidden', condition, model: { ...model, reveal: condition } }
  }
  return { status: 'unrevealed', drewAtRest: startedDrawn }
}
