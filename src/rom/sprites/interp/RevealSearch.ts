/**
 * RevealSearch.ts -- finds the sprites that draw nothing until something happens, and what happens.
 *
 * The at-rest run (D139 D) has Mario at the level entrance, so a sprite that waits for him (a mushroom, a mole) or a
 * switch draws nothing. This reruns it with Mario and the switches changed and reports the first change that makes
 * it draw. Nothing is keyed on a sprite id: the ROM's own sprite loop runs the handler, and only a drawn frame counts.
 * No shell imports: the caller gives the rerun.
 */
import type { SpriteModel } from './SpriteRunner'
import { withSeed, type SeedOverride, type SpriteSeed } from './SpriteSeed'

/** What made a hidden sprite draw, in search order (D142). `none-found` is set by the node side, never found here. */
export type RevealCondition =
  | 'mario-at-sprite'
  | 'mario-left'
  | 'mario-right'
  | 'more-frames'
  | 'p-switch'
  | 'on-off'
  | 'none-found'

export type RevealResult =
  /** Drew at rest and in every probe. */
  | { status: 'visible' }
  /** Blank under some probe; `model` is the first condition's run that draws, `chosen` its first own-drawn pass. */
  | { status: 'hidden'; condition: RevealCondition; model: SpriteModel }
  /** Hidden, and no condition drew it. `drewAtRest`: the real-start run drew, and that picture stands in the door. */
  | { status: 'unrevealed'; drewAtRest: boolean }
  /** Not searched: the run was refused or the sprite removed itself. */
  | { status: 'skipped'; reason: string }
  /** A search rerun was refused and nothing else drew: the interpreter's own reason, not "no condition found". */
  | { status: 'refused'; reason: string }

/** Passes the "more frames" condition runs: 4 times the default 64. */
export const MORE_FRAMES = 256

/**
 * Mario's state in every probe: small, standing, on foot, off Yoshi, in no entrance animation (contact is refused
 * during one, bank_01.asm:5411-5413). Fed to the sprite's code, never drawn. $19 Powerup (rammap.asm:143), $71
 * PlayerAnimation (:563), $72 PlayerInAir (:583), $73 PlayerIsDucking (:592), $187A PlayerRidingYoshi (:1842).
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
 * distance (SubHorizPos, bank_01.asm:6124-6129; it adds $60 and compares with $C0, bank_01.asm:13342-13346), so it
 * hides in a 64 wide band that repeats every 256 px. Eight steps of $20 leave no gap wider than 32; the two far values
 * (low byte $80) cover a sprite that only needs Mario nearby.
 */
export const DISTANCES = [0x00, 0x20, 0x40, 0x60, 0x80, 0xa0, 0xc0, 0xe0, 0x180, -0x180] as const

/** "Just left" and "just right" of the sprite, in pixels. */
const BESIDE = 16

/**
 * A small Mario's box starts 20 px below his Y (MairoClipDispY, bank_03.asm:6941-6945), so standing on the sprite's
 * row puts it 20 px below a 16 px sprite's; 16 above the sprite's Y overlaps it.
 */
const STANDING_ON = -16

/** The cells a probe changes (Mario's Next $94-$97 and Now $D1-$D4, his state, $14AD, $14AF): a run that read none first cannot react. */
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

/** The first pass on which the sprite's own code drew a tile (a child it created does not count), or -1. */
export const ownPass = (m: SpriteModel): number => m.passes.findIndex(p => p.parts.length > 0)

/** The pass a picture is taken from: the run's own pick (a line-guided one included) when the sprite's own tile is on it, else the first such pass. */
export const drawnPass = (m: SpriteModel): number | undefined =>
  m.chosen !== undefined && (m.passes[m.chosen]?.parts.length ?? 0) > 0 ? m.chosen : ownPass(m)

/** Whether a run completed and the sprite's own code drew a tile on some pass. */
export const drew = (m: SpriteModel): boolean => !m.refusal && ownPass(m) >= 0

/**
 * Looks for what makes a hidden sprite draw. `first` is the at-rest run of `seed`; `run` reruns it with a changed
 * seed. `probe` is true for the hidden check, whose rerun may stop at its first drawn pass; the search's reruns run
 * whole. A refused probe does not make the sprite hidden; a refused search rerun that nothing else beats is the answer.
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
  // Blank under any probe (even if the real start drew it) means hidden. Tracked inputs (trackInputs) with none of
  // the probed cells mean every probe would repeat the run; untracked, the probes run.
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
  // The last three reruns keep the real Mario, so for a sprite that drew there they would repeat that frame.
  const startedDrawn = drew(first)
  let refused: string | undefined
  for (const [condition, o] of startedDrawn ? tries.slice(0, 3) : tries) {
    const model = rerun(o)
    if (model.refusal) refused ??= model.refusal
    else if (drew(model))
      return { status: 'hidden', condition, model: { ...model, chosen: drawnPass(model), reveal: condition } } // prettier-ignore
  }
  if (refused && !startedDrawn) return { status: 'refused', reason: refused }
  return { status: 'unrevealed', drewAtRest: startedDrawn }
}
