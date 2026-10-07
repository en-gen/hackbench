/**
 * The collision overlay's composition and refusals (en-gen/hackbench#435), on synthetic tiles and a synthetic
 * ROM: no cartridge. `compose` turns per-tile probe results into lines in map pixels; the probe's own
 * unknown/refusal paths are proven on hand-built routines in a 512 KB buffer, so a probe that went blind
 * would show here, in CI, not only against the corpus.
 */
import { describe, it, expect } from 'vitest'
import { compose, type CollisionLine } from '../../../src/rom/collision/Compose'
import {
  changedRanges,
  collisionLayer,
  ProbeCache,
  SUPERSEDED,
} from '../../../src/rom/collision/MapCollision'
import {
  stateKey,
  calibrate,
  measureTile,
  probeAir,
  Probe,
  type AirRuns,
  type TileProbe,
} from '../../../src/rom/collision/TileProbe'
import { RomFile } from '../../../src/rom/RomFile'

const NONE = Array<number | null>(16).fill(null)
const mk = (over: Partial<TileProbe> = {}): TileProbe => ({ floor: NONE, ceil: NONE, wallL: false, wallR: false, hurt: false, ...over }) // prettier-ignore
const SOLID = mk({ floor: Array(16).fill(0), ceil: Array(16).fill(16), wallL: true, wallR: true })
/** Floor depths rise 0..7 over the left tile and 8..15 over the right: one line across both. */
const SLOPE_L = mk({ floor: Array.from({ length: 16 }, (_, x) => x >> 1) })
const SLOPE_R = mk({ floor: Array.from({ length: 16 }, (_, x) => 8 + (x >> 1)) })
const SPIKE = mk({ floor: Array(16).fill(0), ceil: Array(16).fill(16), wallL: true, wallR: true, hurt: true }) // prettier-ignore
const UNKNOWN = mk({ unknown: 'BRK executed at $00EADB' })
const TILES: Record<number, TileProbe> = {
  0: mk(),
  2: SOLID,
  3: SLOPE_L,
  4: SLOPE_R,
  5: SPIKE,
  6: UNKNOWN,
}
const get = (id: number) => TILES[id]
const of = (lines: CollisionLine[], kind: string) => lines.filter(l => l.kind === kind).map(l => l.points) // prettier-ignore

describe('compose (synthetic tiles)', () => {
  it('a 2x2 block is one top, one underside and two 32 px walls', () => {
    const l = compose([[2, 2], [2, 2]], get) // prettier-ignore
    expect(of(l, 'floor')).toEqual([[0, 0, 32, 0]])
    expect(of(l, 'ceiling')).toEqual([[0, 32, 32, 32]])
    expect(of(l, 'wall')).toEqual([[0, 0, 0, 32], [32, 0, 32, 32]]) // prettier-ignore
    expect(of(l, 'unknown')).toEqual([])
  })

  it('an L of blocks draws its outer corners, and its inner corner where wall meets floor', () => {
    //  # .
    //  # #
    const l = compose([[2, 0], [2, 2]], get) // prettier-ignore
    expect(of(l, 'floor')).toEqual([[0, 0, 16, 0], [16, 16, 32, 16]]) // prettier-ignore
    // The shared face between the two lower blocks is no wall; the inner corner is where the 16 px wall ends on the floor.
    expect(of(l, 'wall')).toEqual([[0, 0, 0, 32], [16, 0, 16, 16], [32, 16, 32, 32]]) // prettier-ignore
    // One underside across both lower blocks, none under the upper block (it rests on one).
    expect(of(l, 'ceiling')).toEqual([[0, 32, 32, 32]])
    const innerWall = of(l, 'wall')[1]!
    expect(innerWall.slice(2)).toEqual(of(l, 'floor')[1]!.slice(0, 2)) // the wall's foot is the second floor's start
  })

  it('a two-tile slope is one line from end to end, with no walls', () => {
    const l = compose([[3, 4]], get)
    const [f, ...rest] = of(l, 'floor')
    expect(rest).toEqual([])
    expect([f![0], f!.at(-2), f![1], f!.at(-1)]).toEqual([0, 32, 0, 15])
    expect(of(l, 'wall')).toEqual([])
  })

  it('draws nothing for a filler, and no top for fill beneath a slope', () => {
    const slope = compose([[3]], get)
    expect(compose([[3], [0]], get)).toEqual(slope) // a passable filler below
    const filled = compose([[3], [2]], get) // a solid below: its top is fill, not surface
    expect(of(filled, 'floor')).toEqual(of(slope, 'floor'))
    expect(of(filled, 'ceiling')).toEqual([[0, 32, 16, 32]]) // the solid's own underside remains
  })

  it('a hazard floor is a floor line like any other', () => {
    expect(of(compose([[5]], get), 'floor')).toEqual([[0, 0, 16, 0]])
  })

  it('an unknown or unprobed tile is a hatched cell, never a blank', () => {
    const l = compose([[2, 6, 9]], get)
    expect(of(l, 'unknown')).toEqual([
      [16, 0, 32, 0, 32, 16, 16, 16, 16, 0],
      [32, 0, 48, 0, 48, 16, 32, 16, 32, 0],
    ])
    // The block still has its right wall: an unknown neighbour does not hide it.
    expect(of(l, 'wall')).toContainEqual([16, 0, 16, 16])
  })

  it('is red when the grid changes: swapping one block for air must move lines', () => {
    expect(compose([[2, 0], [2, 2]], get)).not.toEqual(compose([[2, 2], [2, 2]], get)) // prettier-ignore
  })
})

describe('the probe without a cartridge', () => {
  /** A 512 KB LoROM whose collision entry holds `routine`; the per-frame reset is a bare RTS. */
  const rom = (routine: number[]) => {
    const b = new Uint8Array(0x80000)
    b[0x7fd5] = 0x20
    b[0x6aa6] = 0x60
    b.set(routine, 0x6adb)
    return RomFile.fromBytes('synthetic.sfc', b)
  }
  const loaded = () => {
    const w = new Uint8Array(0x20000)
    w[0x1931] = 7
    return w
  }
  const CAL = { foot: 32, head: 17 }
  /**
   * LDA $96 (Y low); CMP #$60; BCC end; LDA $7EC888 (the cell's low byte); CMP #$30; BNE end;
   * LDA #4; STA $77; LDA #1; STA $13EF; RTS: tile $30 is a floor whose top is at Y = 96, and only
   * a run with Y >= 96 reads the cell.
   */
  const FLOOR_AT_96 = [0xa5, 0x96, 0xc9, 0x60, 0x90, 0x11, 0xaf, 0x88, 0xc8, 0x7e, 0xc9, 0x30, 0xd0, 0x09, 0xa9, 0x04, 0x85, 0x77, 0xa9, 0x01, 0x8d, 0xef, 0x13, 0x60] // prettier-ignore

  it('measures a tile from the routine it runs: tile $30 is a flat floor, another tile is nothing', () => {
    const p = new Probe(rom(FLOOR_AT_96), 0, loaded())
    expect(measureTile(p, 0x30, CAL).floor).toEqual(Array(16).fill(0))
    expect(measureTile(p, 0x31, CAL).floor).toEqual(NONE)
  })

  it('takes untouched positions from the level of air, and the answer is the same', () => {
    const p = new Probe(rom(FLOOR_AT_96), 0, loaded())
    const air = probeAir(p)
    const touched = [...air.values()].filter(r => r.touched).length
    // Only the positions with Y >= 96 read the cell: some do and some do not, so both paths run below.
    expect(touched).toBeGreaterThan(0)
    expect(touched).toBeLessThan(air.size)
    for (const t of [0x30, 0x31])
      expect(measureTile(p, t, CAL, air)).toEqual(measureTile(p, t, CAL))
  })

  it('goes red when the shortcut is wrong: a table that claims no run touched the cell loses the floor', () => {
    const p = new Probe(rom(FLOOR_AT_96), 0, loaded())
    const lie: AirRuns = new Map([...probeAir(p)].map(([k, r]) => [k, { ...r, touched: false }]))
    expect(measureTile(p, 0x30, CAL, lie)).not.toEqual(measureTile(p, 0x30, CAL))
  })

  it('a routine that executes BRK makes the tile unknown, never empty', () => {
    expect(measureTile(new Probe(rom([0x00]), 0, loaded()), 0x30, CAL).unknown).toMatch(/BRK/)
  })

  it('a routine that never returns spends its budget and makes the tile unknown', () => {
    const t = measureTile(new Probe(rom([0x80, 0xfe]), 0, loaded()), 0x30, CAL) // BRA to itself
    expect(t.unknown).toMatch(/budget/)
  })

  it('a routine that leaves ROM makes the tile unknown', () => {
    const t = measureTile(new Probe(rom([0x4c, 0x00, 0x20]), 0, loaded()), 0x30, CAL) // JMP $2000: registers, not code
    expect(t.unknown).toMatch(/left ROM/)
  })

  /**
   * A routine for several tiles: LDA cell; then per tile `CMP #t; BNE next; body; RTS`. Tile $30 is the flat
   * block (floor at Y 96, bonk for Y <= $7F); the others are single behaviours (see MULTI's cases below).
   */
  const blocks = (cases: [number, number[]][]) => [
    0xaf, 0x88, 0xc8, 0x7e,
    ...cases.flatMap(([t, body]) => [0xc9, t, 0xd0, body.length + 1, ...body, 0x60]),
    0x60,
  ] // prettier-ignore
  const FLAT = [0xa5, 0x7d, 0x30, 0x0f, 0xa5, 0x96, 0xc9, 0x60, 0x90, 0x11, 0xa9, 0x04, 0x85, 0x77, 0xa9, 0x01, 0x8d, 0xef, 0x13, 0xa5, 0x96, 0xc9, 0x80, 0xb0, 0x02, 0x64, 0x7d] // prettier-ignore
  const MULTI = blocks([
    [0x30, FLAT],
    // Upward speed zeroed when Y <= $88 (the turn block bonks by zeroing Y speed, not by $77 bit 3).
    [0x31, [0xa5, 0x7d, 0x10, 0x08, 0xa5, 0x96, 0xc9, 0x89, 0xb0, 0x02, 0x64, 0x7d]],
    // Kills (sets $71, no landing flag) once Y >= 96.
    [0x32, [0xa5, 0x96, 0xc9, 0x60, 0x90, 0x04, 0xa9, 0x09, 0x85, 0x71]],
    // Lands from Y >= 90: above the cell top, so no floor.
    [
      0x33,
      [0xa5, 0x96, 0xc9, 0x5a, 0x90, 0x09, 0xa9, 0x04, 0x85, 0x77, 0xa9, 0x01, 0x8d, 0xef, 0x13],
    ],
    // Leaves $77 = 4 behind on every run.
    [0x34, [0xa9, 0x04, 0x85, 0x77]],
    // Sets only the ground flag once Y >= 96: lands only if $77 was left set by an earlier run.
    [0x35, [0xa5, 0x96, 0xc9, 0x60, 0x90, 0x05, 0xa9, 0x01, 0x8d, 0xef, 0x13]],
    // Writes the cell itself (as a collected coin does): LDA #$25; STA $7EC888.
    [0x36, [0xa9, 0x25, 0x8f, 0x88, 0xc8, 0x7e]],
  ])

  /** Lands from Y >= 96 only while the byte at `addr` is non-zero. */
  const WHEN = (addr: number) => [0xad, addr & 255, addr >> 8, 0xf0, 0x0f, 0xa5, 0x96, 0xc9, 0x60, 0x90, 0x09, 0xa9, 0x04, 0x85, 0x77, 0xa9, 0x01, 0x8d, 0xef, 0x13] // prettier-ignore
  const STATE = blocks([
    [0x40, WHEN(0x1f27)], // green
    [0x41, WHEN(0x1f28)], // yellow
    [0x42, WHEN(0x1f29)], // blue
    [0x43, WHEN(0x1f2a)], // red
    [0x44, WHEN(0x14ad)], // blue P-switch
  ])

  it('puts the palace flags and the blue P-switch in the probe WRAM, in SwitchBlockFlags order', () => {
    const off = { flags: { green: false, yellow: false, blue: false, red: false }, bluePs: false }
    const floorOf = (tile: number, over: Partial<typeof off.flags> = {}, bluePs = false) => {
      const p = new Probe(rom(STATE), 0, loaded())
      p.state = { flags: { ...off.flags, ...over }, bluePs }
      return measureTile(p, tile, CAL).floor
    }
    const flat = Array(16).fill(0)
    for (const t of [0x40, 0x41, 0x42, 0x43, 0x44])
      expect(floorOf(t), '$' + t.toString(16)).toEqual(NONE)
    expect(floorOf(0x40, { green: true })).toEqual(flat)
    expect(floorOf(0x41, { yellow: true })).toEqual(flat)
    expect(floorOf(0x42, { blue: true })).toEqual(flat)
    expect(floorOf(0x43, { red: true })).toEqual(flat)
    expect(floorOf(0x44, {}, true)).toEqual(flat)
    // Each byte is its own: yellow does not set green's.
    expect(floorOf(0x40, { yellow: true })).toEqual(NONE)
  })

  it('collisionLayer runs the probe in the state it is given (a floor only while the blue P-switch runs)', async () => {
    const r = rom(blocks([[0x30, FLAT], [0x44, WHEN(0x14ad)]])) // prettier-ignore
    const floors = async (bluePs: boolean) => {
      const out = await collisionLayer(r, 0, 7, [[0x44]], new ProbeCache(), { wram: loaded(), state: { flags: { green: false, yellow: false, blue: false, red: false }, bluePs } }) // prettier-ignore
      if (!out.ok) throw new Error(out.reason)
      return out.lines.filter(l => l.kind === 'floor')
    }
    expect(await floors(false)).toEqual([])
    expect(await floors(true)).toHaveLength(1)
  })

  it('the full state keys a reply (palaces change the grid); the probe cache keys on the blue P-switch only', () => {
    const on = { flags: { green: false, yellow: true, blue: false, red: false }, bluePs: false }
    const off = { ...on, flags: { ...on.flags, yellow: false } }
    expect(stateKey(on)).not.toBe(stateKey(off))
    expect(stateKey({ ...off, bluePs: true })).not.toBe(stateKey(off))
    const c = new ProbeCache()
    c.set(7, 1, mk(), on)
    expect(c.get(7, 1, off)).toBeDefined() // a palace toggle reuses the tile
    expect(c.get(7, 1, { ...off, bluePs: true })).toBeUndefined() // the P-switch does not
    expect(c.get(3, 1, off)).toBeUndefined() // nor another tileset
  })

  it('a palace toggle probes no tile again; a blue P-switch toggle probes them all', async () => {
    const r = rom(blocks([[0x30, FLAT], [0x44, WHEN(0x14ad)]])) // prettier-ignore
    const cache = new ProbeCache()
    const flags = { green: false, yellow: false, blue: false, red: false }
    const run = async (state: { flags: typeof flags; bluePs: boolean }) => {
      const out = await collisionLayer(r, 0, 7, [[0x44, 0x30]], cache, { wram: loaded(), state })
      if (!out.ok) throw new Error(out.reason)
      return out.probed
    }
    expect(await run({ flags, bluePs: false })).toBe(2)
    expect(await run({ flags: { ...flags, yellow: true }, bluePs: false })).toBe(0)
    expect(await run({ flags: { ...flags, red: true }, bluePs: false })).toBe(0)
    expect(await run({ flags, bluePs: true })).toBe(2)
  })

  it('calibrates and measures a flat block: floor 0, underside 16', () => {
    const p = new Probe(rom(MULTI), 0, loaded())
    expect(calibrate(p)).toEqual(CAL)
    const t = measureTile(p, 0x30, CAL)
    expect([t.floor, t.ceil]).toEqual([Array(16).fill(0), Array(16).fill(16)])
  })

  it('a bonk by zeroed Y speed is an underside (the turn block)', () => {
    expect(measureTile(new Probe(rom(MULTI), 0, loaded()), 0x31, CAL).ceil).toEqual(
      Array(16).fill(25),
    )
  })

  it('a tile that kills on touch has its floor and is hurt, though it never lands', () => {
    const t = measureTile(new Probe(rom(MULTI), 0, loaded()), 0x32, CAL)
    expect([t.hurt, t.floor]).toEqual([true, Array(16).fill(0)])
    expect(measureTile(new Probe(rom(MULTI), 0, loaded()), 0x31, CAL).hurt).toBe(false)
  })

  it('a landing above the cell top is no floor', () => {
    expect(measureTile(new Probe(rom(MULTI), 0, loaded()), 0x33, CAL).floor).toEqual(NONE)
  })

  it('restores every byte a run wrote: the next tile does not inherit it', () => {
    const p = new Probe(rom(MULTI), 0, loaded())
    measureTile(p, 0x34, CAL)
    expect(measureTile(p, 0x35, CAL).floor).toEqual(NONE)
  })

  it('a tile that rewrites the cell does not blind the level of air that follows', () => {
    const p = new Probe(rom(MULTI), 0, loaded())
    measureTile(p, 0x36, CAL)
    expect([...probeAir(p).values()].some(r => r.touched)).toBe(true)
  })

  describe('an edit drops only the entries whose reads it touches (incremental equals fresh)', () => {
    const grid = [[0x30, 0x32, 0x33]]
    const bytes = (patch: (b: Uint8Array) => void = () => undefined) => {
      const b = rom(MULTI).buffer.slice()
      patch(b)
      return b
    }
    const at33 =
      0x6adb + MULTI.findIndex((_, i) => MULTI.slice(i, i + 4).join() === '165,150,201,90') + 3 // CMP #$5A of tile $33
    const layer = (b: Uint8Array, cache: ProbeCache) =>
      collisionLayer(RomFile.fromBytes('x.sfc', b), 0, 7, grid, cache, { wram: loaded() })
    const run = async (b: Uint8Array, cache: ProbeCache) => {
      const r = await layer(b, cache)
      if (!r.ok) throw new Error(r.reason)
      return r
    }
    const warm = async () => {
      const [b0, cache] = [bytes(), new ProbeCache()]
      expect((await run(b0, cache)).probed).toBe(3)
      return { b0, cache }
    }

    it('a byte nothing read keeps every entry: no tile is probed again', async () => {
      const { b0, cache } = await warm()
      const b1 = bytes(b => (b[0x70000] ^= 0xff))
      const next = cache.migrate(changedRanges(b0, b1))
      expect(await run(b1, next)).toMatchObject({ probed: 0, dropped: 0 })
    })

    it('a byte inside one tile reads re-probes that tile only, and the result equals a fresh probe', async () => {
      const { b0, cache } = await warm()
      const b1 = bytes(b => (b[at33] = 0x60))
      const next = cache.migrate(changedRanges(b0, b1))
      const inc = await run(b1, next)
      expect([inc.probed, inc.dropped]).toEqual([1, 1])
      const fresh = await run(b1, new ProbeCache())
      expect(inc.lines).toEqual(fresh.lines)
      expect((await run(b0, new ProbeCache())).lines).not.toEqual(fresh.lines) // the edit really changed the answer
    })

    it('goes red when the invalidation ignores what was read: a stale result survives', async () => {
      const { b0, cache } = await warm()
      const b1 = bytes(b => (b[at33] = 0x60))
      const blind = cache.migrate(changedRanges(b0, b0)) // the edit is not passed on
      const stale = await run(b1, blind)
      expect(stale.lines).not.toEqual((await run(b1, new ProbeCache())).lines)
    })

    it('a seed byte a run read drops what read it when the new seed differs; one nothing read does not', async () => {
      // Tile $38 reads $1407 from the seed; the rest never read a seed byte.
      const r = rom(blocks([[0x30, FLAT], [0x38, [0xad, 0x07, 0x14]]])).buffer // prettier-ignore
      const g = [[0x30, 0x38]]
      const ask = async (w: Uint8Array, cache: ProbeCache) => {
        const out = await collisionLayer(RomFile.fromBytes('x.sfc', r), 0, 7, g, cache, { wram: w })
        if (!out.ok) throw new Error(out.reason)
        return out
      }
      const cache = new ProbeCache()
      expect((await ask(loaded(), cache)).probed).toBe(2)
      const unread = loaded()
      unread[0x1f00] = 9
      expect(await ask(unread, cache.migrate([0, 1]))).toMatchObject({ probed: 0, dropped: 0 })
      const read = loaded()
      read[0x1407] = 3
      expect(await ask(read, cache.migrate([0, 1]))).toMatchObject({ probed: 1, dropped: 1 })
    })
  })

  it('refuses a level of air no position of which reaches the cell', () => {
    expect(() => probeAir(new Probe(rom([0x60]), 0, loaded()))).toThrow(/reached the tile cell/)
  })

  it('refuses to calibrate on a block with no ground flag (head found, feet not)', () => {
    const bonkOnly = blocks([[0x30, FLAT.slice(19)]])
    expect(() => calibrate(new Probe(rom(bonkOnly), 0, loaded()))).toThrow(/calibration block/)
  })

  it('runs a whole map through collisionLayer, stops when cancelled, and refuses a tileset mismatch', async () => {
    const grid = [[0x30, 0x31, 0x32]]
    const run = (opts = {}, tileset = 7) => collisionLayer(rom(MULTI), 0, tileset, grid, new ProbeCache(), { wram: loaded(), ...opts }) // prettier-ignore
    const ok = await run()
    if (!ok.ok) throw new Error(ok.reason)
    expect(ok.probed).toBe(3)
    expect(ok.lines.some(l => l.kind === 'floor')).toBe(true)
    let polls = 0
    expect(await run({ cancelled: () => ++polls > 1 })).toEqual({ ok: false, reason: SUPERSEDED })
    expect(polls).toBe(2)
    const wrong = await run({}, 3)
    expect(wrong).toMatchObject({ ok: false, reason: expect.stringMatching(/tileset 7 differs from its header's 3/) }) // prettier-ignore
  })

  it('refuses to calibrate on a block that gives no surface', () => {
    expect(() => calibrate(new Probe(rom([0x60]), 0, loaded()))).toThrow(/calibration block/)
  })
})

describe('collisionLayer refusals (synthetic ROM)', () => {
  const grid = [[0, 0]]
  const refusing = () => {
    const b = new Uint8Array(0x80000)
    b[0x7fd5] = 0x20
    return RomFile.fromBytes('x.sfc', b)
  }

  it('a ROM the level loader refuses is refused with its reason, not an empty layer', async () => {
    const r = await collisionLayer(refusing(), 0x105, 7, grid, new ProbeCache())
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.reason).toMatch(/not the vanilla shape/)
  })

  it('a map whose tiles are all cached needs no ROM run; the same tile on another tileset is not served', async () => {
    const cache = new ProbeCache()
    cache.set(7, 0, mk())
    expect(await collisionLayer(refusing(), 0x105, 7, grid, cache)).toMatchObject({
      ok: true,
      probed: 0,
      lines: [],
    })
    expect((await collisionLayer(refusing(), 0x105, 1, grid, cache)).ok).toBe(false)
  })
})
