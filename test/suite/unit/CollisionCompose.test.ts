/**
 * The collision overlay's composition and refusals (en-gen/hackbench#435), on synthetic tiles and a synthetic
 * ROM: no cartridge. `compose` turns per-tile probe results into lines in map pixels; the probe's own
 * unknown/refusal paths are proven on hand-built routines in a 512 KB buffer, so a probe that went blind
 * would show here, in CI, not only against the corpus.
 */
import { describe, it, expect } from 'vitest'
import { compose, type CollisionLine } from '../../../src/rom/collision/Compose'
import { collisionLayer, ProbeCache } from '../../../src/rom/collision/MapCollision'
import {
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
