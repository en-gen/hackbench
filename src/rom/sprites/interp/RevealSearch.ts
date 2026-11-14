/**
 * RevealSearch.ts -- finds the sprites that draw nothing until something happens, and what happens.
 *
 * The at-rest run (D139 D) has Mario at the level entrance, so a sprite that waits for him (a mushroom, a mole) or a
 * switch draws nothing. This reruns it with Mario and the switches changed and reports the first change that makes
 * it draw. Nothing is keyed on a sprite id: the ROM's own sprite loop runs the handler, and only a drawn frame counts.
 * No shell imports: the caller gives the rerun.
 */
import { drawnParts, type SpriteModel, type SpritePart } from './SpriteRunner'
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
  /**
   * Blank under some probe; `model` is the first condition's run that draws, `chosen` its first own-drawn pass.
   * For a sprite that drew at rest, `model.revealAudit` lists the conditions skipped before it for repeating the
   * at-rest picture (#1365).
   */
  | { status: 'hidden'; condition: RevealCondition; model: SpriteModel }
  /**
   * Hidden, and no condition drew it. `drewAtRest`: the real-start run drew, and that picture stands in the door.
   * `sameAsRest`: the conditions that drew only the at-rest picture again, so were not counted as a reveal (#1365).
   * `refusal`: for a sprite that drew at rest, the first search rerun the interpreter refused (the at-rest picture
   * still stands; the reason is kept so a refused rerun is not mistaken for "tried and nothing").
   */
  | { status: 'unrevealed'; drewAtRest: boolean; sameAsRest: RevealCondition[]; refusal?: string }
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

/** What `findReveal` may be told about how the caller draws a run. */
export interface RevealOptions {
  /**
   * More of the picture than the pass's own parts, from the caller's data (the node side's per-pass player-buffer slot
   * uploads, which `SpriteModel` does not hold). Appended to the picture key of the chosen pass.
   */
  extraKey?: (m: SpriteModel, pass: number) => string
  /**
   * False when the at-rest run and the search reruns are not the same kind of run, so their pictures cannot be
   * compared: the rope's at-rest run is placed in the slot the loader gives it, the reruns run in slot 0 (map-sprites).
   * A repeat then counts as a reveal, as before #1365. Default true.
   */
  comparable?: boolean
}

/**
 * The colors CGRAM holds after pass `p`: the run's writes are cumulative (`PassResult.palette`, in application order)
 * and the last one to a color wins. What the map view draws with (`runtimeColors`, map-sprites.ts), and so what two
 * runs are compared by: the history of writes is not, since a run that writes a color every pass has a longer one.
 */
export const netColors = (m: SpriteModel, p: number): Map<number, number> =>
  new Map(m.passes[p]!.palette.map(w => [w.index, w.bgr555] as const))

/** One part as the comparison sees it. */
const partKey = (q: SpritePart): string =>
  [q.char, q.dx, q.dy, q.palette, q.priority, +q.flipX, +q.flipY, q.size, +!!q.door].join(',')

/**
 * A run's picture as a comparable string: what the map view draws from the pass it takes the picture from
 * (`drawnPass`): every part, companions included (`drawnParts`, the list `interpParts` turns into cells), with the tile,
 * offset, palette row, priority, flips, size and door tag; the children the pass drew, each with its own parts (the map
 * serves each neighbor child as a sprite of its own, `modelResult`); then the pass's upload list, the NET colors at the
 * run's last pass (`netColors`, sorted by index; `runtimeColors` draws with those), then the caller's `extraKey`. Parts
 * are sorted, so the same pieces written to different OAM slots compare equal: the slot only orders overlapping pieces,
 * and priority, which does change what shows, is in the key. The raw attribute byte and OAM position are the same data
 * as the fields above, in game encoding. Colors come from the last pass because a palette-cycling sprite's 256 pass
 * rerun can end on other colors than the 64 pass at-rest run: that is what the map would draw, so it counts as
 * different (hack-only; 0 on vanilla).
 */
const pictureKey = (m: SpriteModel, extra?: RevealOptions['extraKey']): string => {
  const p = drawnPass(m)
  if (p === undefined) return ''
  const pass = m.passes[p]!
  const parts = drawnParts(pass).map(partKey).sort().join(';')
  const kids = (pass.drew?.children ?? [])
    .map(
      c =>
        `${c.index}:${pass.parts
          .filter(q => c.oam.includes(q.oam))
          .map(partKey)
          .sort()
          .join(';')}`,
    )
    .sort()
    .join('/')
  const colors = [...netColors(m, m.passes.length - 1)].sort((x, y) => x[0] - y[0]).map(([i, v]) => `${i}:${v}`).join(',') // prettier-ignore
  return [parts, kids, pass.uploads.join(','), colors, extra?.(m, p) ?? ''].join('|')
}

/** Whether a run completed and the sprite's own code drew a tile on some pass. */
export const drew = (m: SpriteModel): boolean => !m.refusal && ownPass(m) >= 0

/**
 * Looks for what makes a hidden sprite draw. `first` is the at-rest run of `seed`; `run` reruns it with a changed
 * seed. `probe` is true for the hidden check, whose rerun may stop at its first drawn pass; the search's reruns run
 * whole. A refused probe does not make the sprite hidden; a refused search rerun that nothing else beats is the answer
 * for a sprite that never drew, and is carried as `refusal` for one that drew at rest. A sprite that drew at rest gets
 * all six conditions (D192 question 2, ruled 199B), but a condition whose picture equals the at-rest one is no reveal.
 */
export function findReveal(
  seed: SpriteSeed,
  first: SpriteModel,
  run: (seed: SpriteSeed, probe: boolean) => SpriteModel,
  opts: RevealOptions = {},
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
  // A sprite that drew at rest gets all six (D192 question 2, walked as Decision 199, ruled 199B). The last three keep
  // the real Mario, and a Mario-position rerun may draw what the at-rest run drew too (a mole drawn from a start far
  // from it): a picture equal to the at-rest one is no reveal, so it is recorded and the search goes on (#1365
  // acceptance 3), for all six. Whether a Mario-position repeat should still count is the owner's call (D207).
  const startedDrawn = drew(first)
  const restKey =
    startedDrawn && opts.comparable !== false ? pictureKey(first, opts.extraKey) : undefined
  const sameAsRest: RevealCondition[] = []
  let refused: string | undefined
  for (const [condition, o] of tries) {
    const model = rerun(o)
    if (model.refusal) refused ??= model.refusal
    else if (drew(model)) {
      if (restKey !== undefined && pictureKey(model, opts.extraKey) === restKey)
        sameAsRest.push(condition)
      else
        return { status: 'hidden', condition, model: { ...model, chosen: drawnPass(model), reveal: condition, ...(startedDrawn ? { revealAudit: { sameAsRest: [...sameAsRest] } } : {}) } } // prettier-ignore
    }
  }
  if (refused && !startedDrawn) return { status: 'refused', reason: refused }
  return { status: 'unrevealed', drewAtRest: startedDrawn, sameAsRest: [...sameAsRest], ...(refused && startedDrawn ? { refusal: refused } : {}) } // prettier-ignore
}
