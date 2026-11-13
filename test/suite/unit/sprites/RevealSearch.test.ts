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
/** A sprite spot whose low byte lets the real Mario stand left ($40 below it) or right ($40 above it) with INIT's facing differing. */
const X2 = 0x1080

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
    // Id 140 is blank at rest; the check ends at once and the first rerun (Mario at it) draws.
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
  // Id 152 draws unless the LOW byte of (Mario - sprite) is 96-159 (bank_01.asm:13342-13346).
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
    // Id 148 rises $0F on touch, then draws.
    const m = picked(search(148).result)
    const pass = m.passes[m.chosen!]!
    expect(m.anchor).toMatchObject({ x: SX, y: SY })
    expect(pass.pos.y).toBe(SY - 0x0f)
    expect(pass.parts[0]!.dy).toBe(0)
  })

  it('is the model the one at-rest path gives for the revealing seed, with undrawn passes before the drawn one', () => {
    // Id 149 rises every pass and draws only from frame 3 on: pass 0 is undrawn and has already moved the sprite.
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
  // Id 153: INIT sets the X flip when Mario starts left of it; it draws on touch with that flip.
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
  // Id 156 draws only with Mario exactly $40 px right of it: the real start below puts him there.
  it('is reported unrevealed, remembering that it drew from the real start', () => {
    const { result } = search(156, SX, SX + 0x40)
    expect(result).toEqual({
      status: 'unrevealed',
      drewAtRest: true,
      sameAsRest: ['more-frames', 'p-switch', 'on-off'],
    })
  })
  it('control: a sprite that never drew is unrevealed with drewAtRest false', () => {
    expect(search(5).result).toEqual({ status: 'unrevealed', drewAtRest: false, sameAsRest: [] })
  })
  it('control: with Mario elsewhere at the start, the same sprite never drew', () => {
    expect(search(156, SX, 0x80).result).toEqual({
      status: 'unrevealed',
      drewAtRest: false,
      sameAsRest: [],
    })
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

describe('Mario reaches the sprite through every cell the probes move', () => {
  it('Next X ($94): a sprite that reads only it is probed and found hidden, and shown by Mario at it', () => {
    // Real Mario on the sprite: it draws at rest. Tracked, the run read $94 and no other probed cell.
    expect(condition(search(159, SX, SX, {}, true).result)).toBe('mario-at-sprite')
    // Control: a start away from it is blank at rest and the same probe finds it.
    expect(condition(search(159, SX, 0x80, {}, true).result)).toBe('mario-at-sprite')
  })

  it('Mario stands 16 px above the sprite row ($D3 plus 16 is its Y)', () => {
    expect(condition(search(160).result)).toBe('mario-at-sprite')
  })

  const CELLS = [0x19, 0x71, 0x72, 0x73, 0x187a]
  it.each(CELLS)('state cell $%s is zeroed by every probe, and read as a probed cell', cell => {
    const ram = { [cell]: 1 }
    // 162 draws while all five cells are zero: a probe that leaves this one set never shows it.
    expect(condition(search(162, SX, 0x80, { ram }).result)).toBe('mario-at-sprite')
    // 163 adds frame 100: only the more-frames rerun, which must zero the state as well.
    expect(condition(search(163, SX, 0x80, { ram }).result)).toBe('more-frames')
    // 161 draws at rest while any is set: tracked, the read makes it probed; the probe zeroes it and blanks it.
    expect(search(161, SX, 0x80, { ram }, true).result).toEqual({ status: 'unrevealed', drewAtRest: true, sameAsRest: [] }) // prettier-ignore
    // Control: with the cell clear 162 draws at rest and 161 is blank at rest, so the probes above changed something.
    expect(search(162).result.status).toBe('visible')
    expect(search(161).result.status).toBe('unrevealed')
  })
})

describe('the distances (D142)', () => {
  it('a sprite with a 256 px reach is found hidden by the far probes alone (low byte $80 each side)', () => {
    // Id 164 draws while Mario shares its X high byte: every probe within $E0 draws it, $180 either side does not.
    expect(condition(search(164, SX, SX).result)).toBe('mario-at-sprite')
    // Id 170 is blank only when Mario high byte is below its own: the -$180 probe is the one that sees it.
    expect(search(170, SX, SX).result.status).toBe('hidden')
  })

  it('does not put Mario left of the map: at x=16 the -$180 probe is clamped, so no false hiding', () => {
    expect(search(170, 0x10, 0x80).result.status).toBe('visible')
  })

  it('leaves no 32 px window of the low byte unprobed, wherever the window starts', () => {
    // Id 165 is blank for (Mario - sprite) low byte within $20 above the sprite Y low byte: start the window at every value.
    const missed: number[] = []
    for (let low = 0; low < 0x100; low++) {
      const y = 0x100 | low
      const marioX = SX + ((low + 0x80) & 0xff)
      // The camera follows the row, so the entry is never at the $F0 the game keeps for "not drawn".
      const camera = { x: SX - 128, y: y - 0x40 }
      const r = search(165, SX, marioX, { sprite: { x: SX, y }, camera }).result
      if (r.status !== 'hidden') missed.push(low)
    }
    expect(missed).toEqual([])
    // 256 whole searches; a sprite that drew at rest now also runs the three real-Mario reruns (#1365), so the 5 s default is tight.
  }, 30_000)

  it('control: take one step away and some 32 wide window holds no probe', () => {
    const steps = DISTANCES.filter(d => d >= 0 && d < 0x100).map(d => d & 0xff)
    const holes = (without: number) =>
      [...Array(0x100).keys()].filter(low => !steps.some(s => s !== without && ((s - low) & 0xff) < 0x20)) // prettier-ignore
    expect(holes(-1)).toEqual([])
    for (const s of steps) expect(holes(s).length, `without step $${s.toString(16)}`).toBeGreaterThan(0) // prettier-ignore
  })

  it('"just right" and "just left" are 16 px, each tried in its own place, left before right', () => {
    expect(condition(search(166, X2, X2 - 0x40).result)).toBe('mario-right')
    expect(condition(search(167, X2, X2 + 0x40).result)).toBe('mario-left')
    // Id 168 is shown on either side: the first tried wins.
    expect(condition(search(168).result)).toBe('mario-left')
  })

  it('the more-frames rerun reaches frame 200 (the cap is 256, not 128)', () => {
    expect(condition(search(171).result)).toBe('more-frames')
  })
})

describe('the facing of a revealed picture, by the real start (left and right)', () => {
  it.each([
    [166, 'mario-right', X2 - 0x40, true],
    [166, 'mario-right', X2 + 0x40, false],
    [167, 'mario-left', X2 - 0x40, true],
    [167, 'mario-left', X2 + 0x40, false],
  ])('id %i, shown by %s with Mario at %i: flipX %s', (id, cond, marioX, flipX) => {
    const r = search(id, X2, marioX).result
    expect(condition(r)).toBe(cond)
    expect(firstPart(picked(r)).flipX).toBe(flipX)
  })
})

describe('what the reruns run', () => {
  it('a search rerun runs whole; only a probe stops at its first drawn pass', () => {
    const m = picked(search(148).result)
    expect(m.passes.length).toBeGreaterThan(m.chosen! + 1)
    const seed = seedAt(SX, SX)
    const stopped = runOnce(rom, 148, seed, { atRest: true, stopAtDraw: true })
    expect(stopped.passes).toHaveLength(stopped.chosen! + 1)
    expect(runOnce(rom, 148, seed, { atRest: true }).passes.length).toBeGreaterThan(stopped.passes.length) // prettier-ignore
  })

  it('stopAtDraw waits for the own tile of the sprite, not a child it created on an earlier pass', () => {
    const m = runOnce(rom, 172, seedAt(SX, SX), { atRest: true, stopAtDraw: true })
    expect(m.passes.length).toBeGreaterThan(1)
    expect(m.passes[m.passes.length - 1]!.parts.length).toBeGreaterThan(0)
    expect(m.passes.slice(0, -1).some(p => (p.companions?.length ?? 0) > 0)).toBe(true)
    // So the hidden check keeps running to it: this sprite draws at rest and is visible.
    expect(search(172).result.status).toBe('visible')
  })

  it('a probe the interpreter refuses is not a blank run', () => {
    // Id 173 draws, and on touch becomes $FF. Mario at it (the first probe) is refused; every other probe draws it.
    expect(runOnce(rom, 173, seedAt(SX, SX), { atRest: true }).refusal).toMatch(/became \$FF/)
    expect(search(173, SX, 0x80).result.status).toBe('visible')
  })

  it('skips a sprite whose INIT erases it, with the reason', () => {
    expect(search(174).result).toMatchObject({ status: 'skipped', reason: expect.stringMatching(/INIT erased/) }) // prettier-ignore
  })
})

describe('every verdict is the same on a second search, across ids and places', () => {
  const ids = [140, 141, 142, 143, 146, 148, 149, 150, 151, 152, 153, 155, 159, 160, 163, 164, 166, 167, 168, 171] // prettier-ignore
  it.each([SX, 0x1080, 0x10])('x=%i', x => {
    for (const id of ids) {
      const [a, b] = [search(id, x, x + 0x30), search(id, x, x + 0x30)]
      expect(JSON.stringify(a.result), `id ${id}`).toBe(JSON.stringify(b.result))
      expect(a.calls.length, `id ${id} reruns`).toBe(b.calls.length)
    }
  })
})

describe('which pass the revealed model points at', () => {
  // A hand-built run: `own` lists the passes that carry the sprite's own tile; the rest carry only a child.
  const model = (own: number[], chosen: number | undefined, n = 6) =>
    ({
      passes: Array.from({ length: n }, (_, i) => ({
        parts: own.includes(i) ? [{ char: 1 }] : [],
        companions: [{ char: 2 }],
      })),
      chosen,
    }) as unknown as SpriteModel
  const hit = (m: SpriteModel) => {
    const blank = { passes: [], chosen: undefined } as unknown as SpriteModel
    return findReveal(seedAt(SX, 0x80), blank, () => m)
  }

  it('keeps a pick that has the sprite own tile (the line-guided pass), not the first such pass', () => {
    expect(picked(hit(model([1, 3], 3))).chosen).toBe(3)
  })
  it('moves a pick that holds only a child to the first pass with the own tile', () => {
    expect(picked(hit(model([4], 1))).chosen).toBe(4)
  })
})

describe('a sprite that drew at rest gets all six conditions (#1365, D199 B)', () => {
  /** Real Mario $40 px right of the sprite: the only place ids 176-178 draw without a switch. */
  const atRest = (id: number, extra: SeedOverride = {}) => search(id, SX, SX + 0x40, extra)
  const tile = (r: RevealResult) => firstPart(picked(r)).char

  it('finds a sprite that drew at rest and is shown differently only by the P-switch', () => {
    const { result } = atRest(176)
    expect(condition(result)).toBe('p-switch')
    // The picture is the switch's ($32), not the at-rest one ($24).
    expect(tile(result)).toBe(0x32)
    // The more-frames rerun keeps the real Mario, repeats the at-rest picture, and is recorded, not counted.
    expect(result.status === 'hidden' && result.sameAsRest).toEqual(['more-frames'])
  })

  it('finds the ON/OFF case the same way', () => {
    expect(condition(atRest(177).result)).toBe('on-off')
  })

  it('control: the at-rest picture is the other tile, so the P-switch picture is a different one', () => {
    const rest = runOnce(rom, 176, seedAt(SX, SX + 0x40), { atRest: true })
    expect(firstPart(rest).char).toBe(0x24)
  })

  it('does not count a "reveal" that repeats the at-rest picture, and lists it', () => {
    const { result } = atRest(178)
    expect(result).toEqual({
      status: 'unrevealed',
      drewAtRest: true,
      sameAsRest: ['more-frames', 'p-switch', 'on-off'],
    })
  })

  it('control: a sprite that never drew at rest lists nothing, and Mario-position reveals are unchanged', () => {
    const r = search(150).result
    expect(r.status === 'hidden' && r.sameAsRest).toEqual([])
    expect(condition(search(140).result)).toBe('mario-at-sprite')
  })

  it('runs the three non-Mario conditions for a sprite that drew at rest', () => {
    const { calls } = atRest(178)
    expect(calls.some(c => c.mainPasses === MORE_FRAMES)).toBe(true)
    expect(calls.some(c => (c.pSwitch ?? 0) !== 0)).toBe(true)
  })
})

describe('a Mario-position reveal that repeats the at-rest picture still counts ([PROP] #1365)', () => {
  it('id 170 draws the same piece at rest and with Mario at it: revealed, flagged samePicture, not in sameAsRest', () => {
    const r = search(170, SX, SX).result
    expect(r.status).toBe('hidden')
    if (r.status !== 'hidden') return
    expect(r.condition).toBe('mario-at-sprite')
    expect(r.samePicture).toBe(true)
    expect(r.sameAsRest).toEqual([])
    expect(r.model.revealAudit).toEqual({ samePicture: true, sameAsRest: [] })
  })

  it('control: id 176 is revealed by a different picture, so samePicture is false', () => {
    const r = search(176, SX, SX + 0x40).result
    expect(r.status === 'hidden' && r.samePicture).toBe(false)
  })
})
