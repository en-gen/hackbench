/**
 * The smasher's first landing (#997): the schedule with synthetic steps (no ROM, so CI runs it), and
 * the vanilla maps against the code run on the core (corpus). The synthetic steps spell no game code.
 */
import { describe, it, expect } from 'vitest'
import { readL3SmashLoadPos } from '../../../src/rom/L3Smash'
import type { LevelSprite } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import {
  FIRST_LANDING_SCHEDULE,
  firstLanding,
  loadWith,
  STOCK_STEPS,
  type LandingSteps,
} from '../../../src/rom/sprites/interp/SmashLanding'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const rom = new RomFile('synthetic.sfc', Buffer.alloc(0x80000, 0))
const TITLE = 3
const spr = (spriteId: number): LevelSprite => ({ spriteId, x: 1, y: 0, screen: 0, extraBit: false, raw: [], index: 0, streamOffset: 0 }) // prettier-ignore
const MAP = 9

/** Steps where a map load makes `calls[map]` "GetRand calls": the RNG cell counts them, and the smash step reads it back as X. */
function counting(calls: Record<number, number>, log: string[] = []): LandingSteps {
  const cell = (w: Uint8Array) => w[0] | (w[1] << 8)
  return {
    titleMap: () => TITLE,
    load: (_r, map, rng) => {
      log.push(`load ${map} rng ${rng}`)
      const n = (rng + calls[map]!) & 0xffff
      return { wram: Uint8Array.from([n & 0xff, n >> 8]), rng: n }
    },
    smash: (_r, wram) => {
      log.push('smash')
      return { x: cell(wram), y: 0xa0 }
    },
  }
}

describe('FIRST_LANDING_SCHEDULE (synthetic steps)', () => {
  it('runs the title load, then the map load with the RNG the title left, then the smasher', () => {
    const log: string[] = []
    const r = firstLanding(rom, MAP, counting({ [TITLE]: 1, [MAP]: 4 }, log))
    expect(r).toEqual({ ok: true, landing: { x: 5, y: 0xa0 } })
    expect(log).toEqual([`load ${TITLE} rng 0`, `load ${MAP} rng 1`, 'smash'])
    expect(FIRST_LANDING_SCHEDULE).toHaveLength(5)
  })

  it('the landing follows the number of calls the title load makes, and a skipped title step is caught', () => {
    const x = (title: number) => (firstLanding(rom, MAP, counting({ [TITLE]: title, [MAP]: 4 })) as { landing: { x: number } }).landing.x // prettier-ignore
    expect([x(0), x(1), x(3)]).toEqual([4, 5, 7])
    // A planted defect: the map load ignores the RNG the title load left.
    const noCarry: LandingSteps = { ...counting({ [TITLE]: 1, [MAP]: 4 }), load: (_r, map, _rng) => counting({ [TITLE]: 1, [MAP]: 4 }).load(rom, map, 0) } // prettier-ignore
    expect((firstLanding(rom, MAP, noCarry) as { landing: { x: number } }).landing.x).not.toBe(x(1))
  })

  it('reads a 16-bit X as signed, and a map with no loaded smasher as no landing', () => {
    const steps = counting({ [TITLE]: 0, [MAP]: 0 })
    expect(firstLanding(rom, MAP, { ...steps, smash: () => ({ x: 0xff98, y: 0xa0 }) })).toEqual({ ok: true, landing: { x: -104, y: 0xa0 } }) // prettier-ignore
    expect(firstLanding(rom, MAP, { ...steps, smash: () => null })).toEqual({ ok: true, landing: null }) // prettier-ignore
  })

  it('a step that cannot run refuses the whole result with its step named', () => {
    const base = counting({ [TITLE]: 1, [MAP]: 4 })
    const cases: [string, LandingSteps, string][] = [
      ['title map', { ...base, titleMap: () => 'not the shape' }, 'title map load: not the shape'],
      ['title load', { ...base, load: (_r, m, g) => (m === TITLE ? 'loader refused' : base.load(rom, m, g)) }, 'title map load: loader refused'], // prettier-ignore
      ['map load', { ...base, load: (_r, m, g) => (m === MAP ? 'loader refused' : base.load(rom, m, g)) }, 'target map load: loader refused'], // prettier-ignore
      ['smash', { ...base, smash: () => 'sweep did not return' }, 'sweep did not return'], // prettier-ignore
    ]
    for (const [what, steps, want] of cases) {
      expect(firstLanding(rom, MAP, steps), what).toEqual({ ok: false, reason: `the smasher's first landing could not be worked out (${want})` }) // prettier-ignore
    }
  })

  it('readL3SmashLoadPos reads the sprite list first: no smasher is no landing and the interpreter never runs', () => {
    const boom = () => {
      throw new Error('the interpreter ran')
    }
    expect(readL3SmashLoadPos(rom, MAP, boom, () => [spr(0x33)])).toEqual({ ok: true, pos: null })
    expect(readL3SmashLoadPos(rom, MAP, boom, () => [])).toEqual({ ok: true, pos: null })
  })

  it('readL3SmashLoadPos with a smasher passes the landing and the refusal through; an unreadable list is a refusal', () => {
    const smasher = () => [spr(0x33), spr(0x89)]
    expect(readL3SmashLoadPos(rom, MAP, () => ({ ok: true, landing: { x: -104, y: 160 } }), smasher)).toEqual({ ok: true, pos: { x: -104, y: 160 } }) // prettier-ignore
    expect(readL3SmashLoadPos(rom, MAP, () => ({ ok: true, landing: null }), smasher)).toEqual({ ok: true, pos: null }) // prettier-ignore
    expect(readL3SmashLoadPos(rom, MAP, () => ({ ok: false, reason: 'because' }), smasher)).toEqual({ ok: false, reason: 'because' }) // prettier-ignore
    expect(readL3SmashLoadPos(rom, MAP, () => ({ ok: true, landing: null }), () => null)).toMatchObject({ ok: false }) // prettier-ignore
  })
})

/**
 * A cart of NON-vanilla stand-in code that drives the REAL title-map reader and the REAL smash step
 * (rule 9: these routines are not the game's). The sweep fills slot 0 (and 1) with sprite $89; the
 * sprite loop does nothing on its first call and, on its second, copies RNGCalc into $22/$23 and
 * $A0 into $24, as a main routine writes the layer 3 cells after state 0 (#997).
 */
const SWEEP = 0x02aca1
const LOOP = 0x01808c
type CartOpts = {
  title?: number
  lda?: number
  smashers?: 0 | 1 | 2
  brk?: 'sweep' | 'first' | 'second'
  kill?: 'first' | 'second'
}
const smashCart = (o: CartOpts = {}) => {
  const cart = new RomFile('synthetic.sfc', Buffer.alloc(0x80000, 0))
  cart.writeAt(0x00ffd5, [0x20])
  cart.writeAt(0x0096cb, [o.lda ?? 0xa9, o.title ?? 0x27])
  const slot = (i: number) => [0xa9, 0x08, 0x8d, 0xc8 + i, 0x14, 0xa9, 0x89, 0x85, 0x9e + i]
  const n = o.smashers ?? 1
  const brk = (at: CartOpts['brk']) => (o.brk === at ? [0x00] : [])
  const kill = (at: CartOpts['kill']) => (o.kill === at ? [0x9c, 0xc8, 0x14] : []) // STZ the slot's status
  cart.writeAt(SWEEP, [...brk('sweep'), ...(n > 0 ? slot(0) : []), ...(n > 1 ? slot(1) : []), 0x60])
  const second = [0xad, 0x8b, 0x14, 0x85, 0x22, 0xad, 0x8c, 0x14, 0x85, 0x23, 0xa9, 0xa0, 0x85, 0x24, 0x64, 0x25, ...kill('second'), 0x6b] // prettier-ignore
  cart.writeAt(LOOP, [0xad, 0x00, 0x1f, 0xd0, 0x04 + brk('first').length + kill('first').length, ...brk('first'), ...kill('first'), 0xee, 0x00, 0x1f, 0x6b, ...brk('second'), ...second]) // prettier-ignore
  return cart
}
/** A loader that models n GetRand calls per map as +n on RNGCalc, written where the real one leaves it. */
const fakeLoader = (calls: (map: number) => number) => (_r: RomFile, map: number, rng: number) => {
  const wram = new Uint8Array(0x20000)
  const n = (rng + calls(map)) & 0xffff
  wram[0x148b] = n & 0xff
  wram[0x148c] = n >> 8
  return { ok: true as const, wram, steps: 0 }
}
const realSteps = (calls: (map: number) => number = m => m): LandingSteps => ({ ...STOCK_STEPS, load: loadWith(fakeLoader(calls) as never) }) // prettier-ignore
const landing = (cart: RomFile, steps = realSteps()) => {
  const r = firstLanding(cart, 9, steps)
  return r.ok ? r.landing : r.reason
}

describe('the real title reader and smash step on a stand-in cart (synthetic)', () => {
  it('reads the title map from the LDA operand, decoded as the game does, and the landing follows the RNG count', () => {
    // title operand $27 -> map 3 (an operand from $25 up drops $24), $05 -> map 5; the map is 9: X = title + 9
    expect(landing(smashCart({ title: 0x27 }))).toEqual({ x: 3 + 9, y: 0xa0 })
    expect(landing(smashCart({ title: 0x05 }))).toEqual({ x: 5 + 9, y: 0xa0 })
    expect(landing(smashCart({ title: 0x29 }), realSteps(m => (m === 5 ? 7 : m)))).toEqual({ x: 7 + 9, y: 0xa0 }) // prettier-ignore
  })

  it('reads RNGCalc as 16 bits, and X as signed', () => {
    // The title load leaves $0100 + 3: a carry that kept only the low byte would lose the $0100.
    expect(landing(smashCart({ title: 0x27 }), realSteps(m => (m === 3 ? 0x100 : m)))).toEqual({ x: 0x100 + 9, y: 0xa0 }) // prettier-ignore
    expect(landing(smashCart(), realSteps(m => (m === 9 ? 0x1ff : 0)))).toEqual({ x: 0x1ff, y: 0xa0 }) // prettier-ignore
    expect(landing(smashCart(), realSteps(m => (m === 9 ? 0xff98 : 0)))).toEqual({ x: -104, y: 0xa0 }) // prettier-ignore
  })

  it('refuses when the byte before the title operand is not the LDA immediate', () => {
    expect(landing(smashCart({ lda: 0xea }))).toMatch(
      /^the smasher's first landing could not be worked out \(title map load/,
    )
  })

  it('no smasher in the sweep is no landing; two are refused by name', () => {
    expect(firstLanding(smashCart({ smashers: 0 }), 9, realSteps())).toEqual({ ok: true, landing: null }) // prettier-ignore
    expect(landing(smashCart({ smashers: 2 }))).toBe("the smasher's first landing could not be worked out (several smash sprites are loaded)") // prettier-ignore
  })

  it('a sweep or pass that does not return refuses, each under its own name', () => {
    expect(landing(smashCart({ brk: 'sweep' }))).toMatch(/^the smasher's first landing could not be worked out \(the start-up sprite sweep/) // prettier-ignore
    expect(landing(smashCart({ brk: 'first' }))).toMatch(/^the smasher's first landing could not be worked out \(the first sprite pass/) // prettier-ignore
    expect(landing(smashCart({ brk: 'second' }))).toMatch(/^the smasher's first landing could not be worked out \(the second sprite pass/) // prettier-ignore
  })

  it('refuses when the smasher is gone after a pass (status cleared), naming the pass', () => {
    expect(landing(smashCart({ kill: 'first' }))).toBe("the smasher's first landing could not be worked out (the smash sprite did not survive the first sprite pass)") // prettier-ignore
    expect(landing(smashCart({ kill: 'second' }))).toBe("the smasher's first landing could not be worked out (the smash sprite did not survive the second sprite pass)") // prettier-ignore
  })

  it('both passes run: the second pass is what writes the layer 3 cells', () => {
    expect(
      landing(
        smashCart(),
        realSteps(() => 1),
      ),
    ).toEqual({ x: 2, y: 0xa0 })
  })
})

describe.skipIf(!hasRom(VANILLA))('the first landing on the vanilla ROM (corpus, #997)', () => {
  const vanilla = () => RomFile.load(romPath(VANILLA))
  const landingOf = (r: RomFile, map: number, steps?: LandingSteps) => {
    const out = firstLanding(r, map, steps)
    if (!out.ok) throw new Error(out.reason)
    return out.landing
  }

  it('$01F, $1D4 and $1FC land at X -104 (sprite X $FF98), Y $A0', () => {
    const r = vanilla()
    expect(landingOf(r, 0x01f)).toEqual({ x: -104, y: 0xa0 })
    expect(landingOf(r, 0x1d4)).toEqual({ x: -104, y: 0xa0 })
    expect(landingOf(r, 0x1fc)).toEqual({ x: -104, y: 0xa0 })
  })

  it('the title load matters: another title map, or the map twice, lands elsewhere', () => {
    const r = vanilla()
    const stock = landingOf(r, 0x01f)!
    const title = (n: number): LandingSteps => ({ ...STOCK_STEPS, titleMap: () => n })
    // Map $01F as the "title" adds its own GetRand calls first.
    expect(landingOf(r, 0x01f, title(0x01f))!.x).not.toBe(stock.x)
  })

  it('a map with no smasher has no landing', () => {
    expect(landingOf(vanilla(), 0x105)).toBeNull()
  })
})
