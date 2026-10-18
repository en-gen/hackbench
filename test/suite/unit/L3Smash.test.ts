/**
 * The smasher's first landing (#997): the schedule with synthetic steps (no ROM, so CI runs it), and
 * the vanilla maps against the code run on the core (corpus). The synthetic steps spell no game code.
 */
import { describe, it, expect } from 'vitest'
import { readL3SmashLoadPos } from '../../../src/rom/L3Smash'
import { RomFile } from '../../../src/rom/RomFile'
import {
  FIRST_LANDING_SCHEDULE,
  firstLanding,
  STOCK_STEPS,
  type LandingSteps,
} from '../../../src/rom/sprites/interp/SmashLanding'
import { VANILLA, hasRom, romPath } from '../support/corpus'

const rom = new RomFile('synthetic.sfc', Buffer.alloc(0x80000, 0))
const TITLE = 3
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
      ['title map', { ...base, titleMap: () => 'not the shape' }, 'title map load (not the shape)'],
      ['title load', { ...base, load: (_r, m, g) => (m === TITLE ? 'loader refused' : base.load(rom, m, g)) }, 'title map load (loader refused)'], // prettier-ignore
      ['map load', { ...base, load: (_r, m, g) => (m === MAP ? 'loader refused' : base.load(rom, m, g)) }, 'target map load (loader refused)'], // prettier-ignore
      ['smash', { ...base, smash: () => 'sweep did not return' }, 'start-up sprite sweep (sweep did not return)'], // prettier-ignore
    ]
    for (const [what, steps, want] of cases) {
      expect(firstLanding(rom, MAP, steps), what).toEqual({ ok: false, reason: `Layer 3 not drawn yet: ${want}` }) // prettier-ignore
    }
  })

  it('readL3SmashLoadPos passes the landing and the refusal through', () => {
    expect(readL3SmashLoadPos(rom, MAP, () => ({ ok: true, landing: { x: -104, y: 160 } }))).toEqual({ ok: true, pos: { x: -104, y: 160 } }) // prettier-ignore
    expect(readL3SmashLoadPos(rom, MAP, () => ({ ok: true, landing: null }))).toEqual({ ok: true, pos: null }) // prettier-ignore
    expect(readL3SmashLoadPos(rom, MAP, () => ({ ok: false, reason: 'because' }))).toEqual({ ok: false, reason: 'because' }) // prettier-ignore
  })
})

describe.skipIf(!hasRom(VANILLA))('the first landing on the vanilla ROM (corpus, #997)', () => {
  const vanilla = () => RomFile.load(romPath(VANILLA))
  const landing = (r: RomFile, map: number, steps?: LandingSteps) => {
    const out = firstLanding(r, map, steps)
    if (!out.ok) throw new Error(out.reason)
    return out.landing
  }

  it('$01F and $1D4 land at X -104 (sprite X $FF98), Y $A0; $1FC is reported', () => {
    const r = vanilla()
    expect(landing(r, 0x01f)).toEqual({ x: -104, y: 0xa0 })
    expect(landing(r, 0x1d4)).toEqual({ x: -104, y: 0xa0 })
    console.log('smash first landing $1FC', JSON.stringify(landing(r, 0x1fc)))
  })

  it('the title load matters: another title map, or the map twice, lands elsewhere', () => {
    const r = vanilla()
    const stock = landing(r, 0x01f)!
    const title = (n: number): LandingSteps => ({ ...STOCK_STEPS, titleMap: () => n })
    // Map $01F as the "title" adds its own GetRand calls first.
    expect(landing(r, 0x01f, title(0x01f))!.x).not.toBe(stock.x)
  })

  it('a map with no smasher has no landing', () => {
    expect(landing(vanilla(), 0x105)).toBeNull()
  })
})
