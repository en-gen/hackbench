/**
 * The reveal search (#1132) on a SYNTHETIC cart: sprites that draw only on a condition (syntheticRevealSprites.ts),
 * so CI needs no ROM. Every verdict here is also shown to change when its input does: a control beside each claim.
 */
import { describe, expect, it } from 'vitest'
import {
  DISTANCES,
  drew,
  findReveal,
  MORE_FRAMES,
  type RevealResult,
} from '../../../../src/rom/sprites/interp/RevealSearch'
import { runOnce, type SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import {
  withSeed,
  type SeedOverride,
  type SpriteSeed,
} from '../../../../src/rom/sprites/interp/SpriteSeed'
import { buildSyntheticRom } from '../../support/syntheticSpriteRom'

const rom = buildSyntheticRom()
const [SX, SY] = [0x1000, 0x120]

/** A seed with the sprite at (x, SY) and the real Mario at marioX, the camera on the sprite. */
const seedAt = (x: number, marioX: number, extra: SeedOverride = {}): SpriteSeed =>
  withSeed({ sprite: { x, y: SY }, camera: { x: x - 128, y: 0x40 }, mario: { x: marioX, y: SY, dir: 1 }, ...extra }) // prettier-ignore

interface Search {
  result: RevealResult
  /** The seeds the reruns were given, in order. */
  calls: SpriteSeed[]
}

/** The search over sprite id at x with real Mario at marioX. */
function search(
  id: number,
  x = SX,
  marioX = 0x80,
  extra: SeedOverride = {},
  track = false,
): Search {
  const seed = seedAt(x, marioX, extra)
  const calls: SpriteSeed[] = []
  const run = (q: SpriteSeed, probe: boolean) => {
    calls.push(q)
    return runOnce(rom, id, q, { atRest: true, stopAtDraw: probe })
  }
  const first = runOnce(rom, id, seed, { atRest: true, trackInputs: track })
  return { result: findReveal(seed, first, run), calls }
}

const condition = (r: RevealResult) => (r.status === 'hidden' ? r.condition : r.status)
const picked = (r: RevealResult): SpriteModel => {
  if (r.status !== 'hidden') throw new Error(`not hidden: ${r.status}`)
  return r.model
}
const firstPart = (m: SpriteModel) => m.passes.flatMap(p => p.parts)[0]!

describe('the reveal search finds what shows a hidden sprite, in the D142 order', () => {
  it.each([
    [140, 'mario-at-sprite'],
    [141, 'mario-right'],
    [142, 'mario-left'],
    [155, 'more-frames'],
    [150, 'p-switch'],
    [151, 'on-off'],
  ])('sprite %i is shown by %s', (id, expected) => {
    expect(condition(search(id).result)).toBe(expected)
  })

  it('takes the first condition that draws: a touch sprite with a switch active still reports Mario', () => {
    const both = search(140, SX, 0x80, { pSwitch: 0xb0 })
    expect(condition(both.result)).toBe('mario-at-sprite')
  })

  it('draws a plain sprite as visible, and runs every distance to say so', () => {
    const { result, calls } = search(0)
    expect(result.status).toBe('visible')
    expect(calls).toHaveLength(DISTANCES.length)
  })

  it('probes nothing for a sprite whose run never read Mario or a switch, and still probes one that did', () => {
    // Id 0 draws from its own spot and the camera only; id 2 flips by Mario's side ($D1).
    expect(search(0, SX, 0x80, {}, true).calls).toHaveLength(0)
    expect(search(0, SX, 0x80, {}, true).result.status).toBe('visible')
    expect(search(2, SX, 0x80, {}, true).calls).toHaveLength(DISTANCES.length)
    // Control: untracked, the same sprite is probed, so the skip is what removed them.
    expect(search(0).calls).toHaveLength(DISTANCES.length)
  })

  it('still searches a blank sprite that read nothing of Mario (the skip is for sprites that drew)', () => {
    expect(search(5, SX, 0x80, {}, true).result.status).toBe('unrevealed')
    expect(condition(search(155, SX, 0x80, {}, true).result)).toBe('more-frames')
  })

  it('stops at the first blank run: a hidden sprite needs no further probes', () => {
    // Id 40 is blank at rest; the check ends at once and the first rerun (Mario at it) draws.
    const { result, calls } = search(140)
    expect(result.status).toBe('hidden')
    expect(calls).toHaveLength(1)
  })

  it('is deterministic: two searches give the same verdict and picture', () => {
    const [a, b] = [search(148).result, search(148).result]
    expect(JSON.stringify(a)).toBe(JSON.stringify(b))
  })
})

describe('a sprite that never reveals stops at the cap and gets no picture', () => {
  it('reports unrevealed after the bounded conditions, the longest run being the more-frames cap', () => {
    // Id 5 draws nothing at all.
    const { result, calls } = search(5)
    expect(result.status).toBe('unrevealed')
    expect(Math.max(...calls.map(c => c.mainPasses))).toBe(MORE_FRAMES)
    expect(calls.length).toBeLessThanOrEqual(DISTANCES.length + 6)
  })

  it('control: a sprite due at frame 100 is found within the cap', () => {
    expect(condition(search(155).result)).toBe('more-frames')
  })
})

describe('the low byte of the distance (the mole)', () => {
  // Id 52 draws unless the LOW byte of (Mario - sprite) is 96-159 (bank_01.asm:13341-13346).
  const xs = [0x10, 0x5f, 0x60, 0x9f, 0xa0, 0xff, 0x1000, 0x1060, 0x1234, 0x12a3]
  it.each(xs)('is found hidden for a sprite at x=%i, though it draws where Mario starts', x => {
    // Real Mario on the sprite: the real-start run draws, so only a probe can say it is hidden.
    const first = runOnce(rom, 152, seedAt(x, x), { atRest: true })
    expect(drew(first)).toBe(true)
    expect(search(152, x, x).result.status).toBe('hidden')
  })

  it('control: probes of the whole distance alone (0 and 256) miss it, which is why the low byte is stepped', () => {
    for (const x of xs) {
      const seed = seedAt(x, x)
      const coarse = [0, 0x100].map(d =>
        drew(
          runOnce(rom, 152, withSeed({ marioMain: { x: x + d, y: SY } }, seed), { atRest: true }),
        ),
      )
      expect(coarse).toEqual([true, true])
    }
  })
})

describe('a sprite that rewrites its own number is followed', () => {
  it('draws the sprite it became: a changed replacement id draws that sprite instead', () => {
    const tile = (id: number) => firstPart(picked(search(id).result)).char
    expect([tile(143), tile(146)]).toEqual([0x30, 0x32])
  })

  it('refuses when the new number has no handler, and finds no picture', () => {
    const m = runOnce(rom, 147, seedAt(SX, SX), { atRest: true })
    expect(m.refusal).toMatch(/became \$FF/)
    // A rerun's refusal is the answer, in its own words, not "no condition found" (a lone blank at rest, then refused).
    expect(search(147).result).toMatchObject({ status: 'refused', reason: expect.stringMatching(/became \$FF/) }) // prettier-ignore
  })

  it('a sprite that removes itself (status 0) is not followed to the number it left behind', () => {
    // Id 158 draws, then at frame 5 sets status 0 and leaves $FF in $9E: the game never dispatches a dead sprite.
    const m = runOnce(rom, 158, seedAt(SX, SX), { atRest: true })
    expect(m.refusal).toBeUndefined()
    expect(drew(m)).toBe(true)
    expect(m.passes.length).toBeGreaterThan(5)
  })
})

describe('a sprite that creates a child every pass (own parts decide, on any pass)', () => {
  it('is revealed by the first condition that makes its own tile draw, though a child drew before it', () => {
    const r = search(157).result
    expect(condition(r)).toBe('mario-at-sprite')
    const m = picked(r)
    expect(m.passes[m.chosen!]!.parts.length).toBeGreaterThan(0)
  })
  it('control: with Mario away it only creates children and stays unrevealed', () => {
    const m = runOnce(rom, 157, seedAt(SX, 0x80), { atRest: true })
    expect(m.passes.some(p => (p.companions?.length ?? 0) > 0)).toBe(true)
    expect(drew(m)).toBe(false)
  })
})

describe('where the revealed picture stands', () => {
  it('is the placed spot, not where the trigger moved the sprite', () => {
    // Id 48 rises $0F on touch, then draws.
    const m = picked(search(148).result)
    const pass = m.passes[m.chosen!]!
    expect(m.anchor).toMatchObject({ x: SX, y: SY })
    expect(pass.pos.y).toBe(SY - 0x0f)
    expect(pass.parts[0]!.dy).toBe(0)
  })

  it('is the model the one at-rest path gives for the revealing seed, with undrawn passes before the drawn one', () => {
    // Id 49 rises every pass and draws only from frame 3 on: pass 0 is undrawn and has already moved the sprite.
    const hit = search(149)
    const m = picked(hit.result)
    expect(m.chosen).toBeGreaterThan(0)
    const again = runOnce(rom, 149, hit.calls[0]!, { atRest: true })
    expect(m.anchor).toEqual(again.anchor)
    expect(m.passes[m.chosen!]).toEqual(again.passes[again.chosen!])
    // Control: the sprite really moved, so a position taken from pos would differ from the placed one.
    expect(m.passes[m.chosen!]!.pos.y).toBeLessThan(SY)
    expect(m.anchor!.y).toBe(SY)
  })
})

describe('the facing a revealed picture keeps', () => {
  // Id 53: INIT sets the X flip when Mario starts left of it; it draws on touch with that flip.
  // The fixture compares low bytes only, so the sprite sits where Mario 0x40 px either side keeps the same high byte.
  const X = 0x1080
  const flip = (marioX: number) => firstPart(picked(search(153, X, marioX).result)).flipX
  it('follows the side the real Mario is on, not the side of the condition that revealed it', () => {
    expect([flip(X - 0x40), flip(X + 0x40)]).toEqual([true, false])
  })
  it('is the same whichever condition reveals it: Mario at the sprite after INIT never changes it', () => {
    const right = search(153, X, X + 0x40).result
    expect(condition(right)).toBe('mario-at-sprite')
    expect(firstPart(picked(right)).flipX).toBe(false)
  })
})

describe('created sprites do not count as drawing (D106A)', () => {
  it('a sprite that only creates one stays unrevealed', () => {
    expect(search(154).result.status).toBe('unrevealed')
  })
  // Since #840 a run keeps a created sprite's tiles in `companions`, never in `parts`; this proves they were
  // written (so the check above is not passing on an empty run) and that only `parts` decide "drew".
  it('control: the created sprite wrote tiles, held as companions, and none are its own parts', () => {
    const { result, calls } = search(154)
    expect(result.status).toBe('unrevealed')
    // The search's own reruns, whole: some probe made the sprite create its child.
    const runs = calls.map(q => runOnce(rom, 154, q, { atRest: true }))
    expect(runs.some(m => m.passes.some(p => (p.companions?.length ?? 0) > 0))).toBe(true)
    for (const m of runs) {
      expect(m.passes.flatMap(p => p.parts)).toHaveLength(0)
      expect(drew(m)).toBe(false)
    }
  })
})

describe('a sprite that drew at rest, is found hidden, and no condition reveals', () => {
  // Id 56 draws only with Mario exactly $40 px right of it: the real start below puts him there.
  it('is reported unrevealed, remembering that it drew from the real start', () => {
    const { result } = search(156, SX, SX + 0x40)
    expect(result).toEqual({ status: 'unrevealed', drewAtRest: true })
  })
  it('control: a sprite that never drew is unrevealed with drewAtRest false', () => {
    expect(search(5).result).toEqual({ status: 'unrevealed', drewAtRest: false })
  })
  it('control: with Mario elsewhere at the start, the same sprite never drew', () => {
    expect(search(156, SX, 0x80).result).toEqual({ status: 'unrevealed', drewAtRest: false })
  })
})

describe('a refused run is not searched', () => {
  it('skips the search after a refusal and runs nothing more', () => {
    // Id 4 executes COP in MAIN.
    const { result, calls } = search(4)
    expect(result.status).toBe('skipped')
    expect(calls).toHaveLength(0)
  })
})
