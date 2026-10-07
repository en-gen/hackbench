/**
 * The collision probe against the vanilla ROM (en-gen/hackbench#435). The expectations are the spike's
 * signed-off output (`collisionBaseline.ts`, numbers only, no ROM bytes): every Map16 id on maps $105, $10A and
 * $111 and each map's line counts and checksum. The planted defects prove the probe can go red: a BRK in the
 * routine, the slope table zeroed, a tile that kills on touch from above. The synthetic twins of the
 * refusal paths are in CollisionCompose.test.ts and run without a cartridge.
 *
 * Skipped without the vanilla ROM; the skip count is part of the report.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { buildL1Inputs } from '../../../src/rom/model/L1Model'
import {
  changedRanges,
  collisionLayer,
  ProbeCache,
  rangesIntersect,
} from '../../../src/rom/collision/MapCollision'
import {
  calibrate,
  measureTile,
  probeAir,
  Probe,
  type TileProbe,
} from '../../../src/rom/collision/TileProbe'
import { COLLISION_BASELINE } from '../support/collisionBaseline'
import { freshRom, hasRom, romPath, VANILLA } from '../support/corpus'

const FLAGS = { yellow: false, green: false, red: false, blue: false }
const n = (v: number | null) => (v === null ? '-' : String(v))
/** A tile's result in the baseline's notation. */
const sig = (t: TileProbe) =>
  `${t.floor.map(n).join(',')}/${t.ceil.map(n).join(',')}/${+t.wallL}${+t.wallR}${+t.hurt}${t.unknown ? 'u' : ''}` // prettier-ignore

function mapOf(level: number) {
  const r = buildL1Inputs(SmwRom.open(romPath(VANILLA)), level, FLAGS)
  if (!r.ok) throw new Error(r.reason)
  return r.inputs
}
const kinds = (lines: { kind: string; points: number[] }[], k: string) => lines.filter(l => l.kind === k) // prettier-ignore

describe.skipIf(!hasRom(VANILLA))('collision probe on the vanilla ROM', () => {
  for (const level of [0x105, 0x10a, 0x111]) {
    const base = COLLISION_BASELINE[level]!
    describe(`map $${level.toString(16)}`, () => {
      it('matches the signed-off output for every tile id on the map, lines included', async () => {
        const m = mapOf(level)
        const cache = new ProbeCache()
        const r = await collisionLayer(freshRom(), level, m.header.objectTileset, m.grid, cache)
        if (!r.ok) throw new Error(r.reason)
        expect([m.header.objectTileset, m.grid.length, m.grid[0]!.length]).toEqual([base.tileset, base.rows, base.cols]) // prettier-ignore
        const onMap = [...new Set(m.grid.flat())].sort((a, b) => a - b)
        expect(onMap.length).toBeGreaterThan(20) // a map with no ids would pass the loop below
        // The ids the baseline holds are exactly the ids on the map: nothing probed that is not kept, nothing kept that is not probed.
        expect(Object.keys(base.ids).map(Number)).toEqual(onMap)
        const wrong = onMap.filter(id => sig(cache.get(base.tileset, id)!) !== base.ids[id])
        expect(wrong.map(id => '$' + id.toString(16))).toEqual([])
        const count = (k: string) => kinds(r.lines, k).length
        expect({ floor: count('floor'), ceiling: count('ceiling'), wall: count('wall'), unknown: count('unknown') }).toEqual(base.counts) // prettier-ignore
        const sum = [...kinds(r.lines, 'floor'), ...kinds(r.lines, 'ceiling'), ...kinds(r.lines, 'wall')]
          .reduce((s, l) => s + l.points.reduce((a, c) => a + c, 0), 0) // prettier-ignore
        expect(sum).toBe(base.sum)
      }, 120_000)
    })
  }

  it('$105 has its known floor segments at their map coordinates', async () => {
    const m = mapOf(0x105)
    const r = await collisionLayer(freshRom(), 0x105, 7, m.grid, new ProbeCache())
    if (!r.ok) throw new Error(r.reason)
    const floors = kinds(r.lines, 'floor').map(l => l.points)
    // A slope joined across tiles (176,335 down to 224,288) and a run of single-tile ledges (832,384 ...).
    expect(floors).toContainEqual([176, 335, 176.5, 335, 223.5, 288, 224, 288])
    expect(floors).toContainEqual([832, 384, 848, 384])
    expect(kinds(r.lines, 'wall').map(l => l.points)).toContainEqual([3344, 240, 3344, 256])
  }, 120_000)

  it('$111 floor spikes carry a floor line along each spike cell (the $111 fix)', async () => {
    const m = mapOf(0x111)
    const cache = new ProbeCache()
    const r = await collisionLayer(freshRom(), 0x111, 1, m.grid, cache)
    if (!r.ok) throw new Error(r.reason)
    const spikes = new Set([0x159, 0x15a, 0x15c])
    const floors = kinds(r.lines, 'floor').map(l => l.points)
    let cells = 0
    m.grid.forEach((row, y) =>
      row.forEach((id, x) => {
        if (!spikes.has(id)) return
        // Not fill under another floor: a cell whose own top counts is one with no floor cell above it.
        if (y > 0 && cache.get(1, m.grid[y - 1]![x]!)!.floor[0] !== null) return
        cells++
        const covers = floors.some(p => {
          const ys = p.filter((_, i) => i % 2)
          const xs = p.filter((_, i) => !(i % 2))
          return ys.every(v => v === y * 16) && Math.min(...xs) <= x * 16 && Math.max(...xs) >= x * 16 + 16 // prettier-ignore
        })
        expect(covers, `spike cell ${x},${y}`).toBe(true)
      }),
    )
    expect(cells).toBeGreaterThan(0)
  }, 120_000)

  it('keys the cache on the tileset: $159 is solid on tileset 7 and a hazard on tileset 1', () => {
    expect(COLLISION_BASELINE[0x105]!.ids[0x159]).toMatch(/\/110$/)
    expect(COLLISION_BASELINE[0x111]!.ids[0x159]).toMatch(/\/111$/)
    const c = new ProbeCache()
    const t = measureTile(new Probe(freshRom(), 0x111), 0x159, { foot: 32, head: 17 })
    c.set(1, 0x159, t)
    expect(c.get(1, 0x159)).toBe(t)
    expect(c.get(7, 0x159)).toBeUndefined()
  })

  it('calibrates Mario small: foot 32, head 17 on a flat block', () => {
    expect(calibrate(new Probe(freshRom(), 0x105))).toEqual({ foot: 32, head: 17 })
  })

  it('serves a revisit from the cache: no tile probed, the same lines', async () => {
    const m = mapOf(0x111)
    const cache = new ProbeCache()
    let yields = 0
    const first = await collisionLayer(freshRom(), 0x111, 1, m.grid, cache, { yieldTurn: async () => void yields++ }) // prettier-ignore
    const again = await collisionLayer(freshRom(), 0x111, 1, m.grid, cache)
    if (!first.ok || !again.ok) throw new Error('refused')
    expect(first.probed).toBeGreaterThan(20)
    expect(yields).toBe(first.probed) // the event loop is given back after every tile
    expect(again.probed).toBe(0)
    expect(again.lines).toEqual(first.lines)
  }, 120_000)

  it('stops between tiles when told the working copy moved on', async () => {
    const m = mapOf(0x111)
    let calls = 0
    const r = await collisionLayer(freshRom(), 0x111, 1, m.grid, new ProbeCache(), { cancelled: () => ++calls > 3 }) // prettier-ignore
    expect(r).toEqual({ ok: false, reason: 'superseded' })
  }, 120_000)

  it('takes untouched positions from the level of air without changing any answer', () => {
    // Slopes, a ledge, a solid, fillers, a ceiling slope, the muncher, the hazard ids and a passable id.
    const ids = [0x025, 0x100, 0x130, 0x1aa, 0x1c4, 0x1c8, 0x1cb, 0x1d8, 0x12f, 0x159, 0x1fb, 0x021]
    const p = new Probe(freshRom(), 0x105)
    const cal = calibrate(p)
    const air = probeAir(p)
    const skipped = [...air.values()].filter(r => !r.touched).length
    expect(skipped).toBeGreaterThan(air.size / 4) // the shortcut is doing something
    for (const id of ids) expect(measureTile(p, id, cal, air), '$' + id.toString(16)).toEqual(measureTile(p, id, cal)) // prettier-ignore
  }, 120_000)

  describe('the spike findings each have a witness', () => {
    const cal = { foot: 32, head: 17 }

    it('clears PlayerAnimation ($71) first: a level that loads with it set is not all hazard', () => {
      // $1C6 loads with $71 set by its entrance (spike README); air must still read as harmless.
      expect(measureTile(new Probe(freshRom(), 0x1c6), 0x25, cal).hurt).toBe(false)
    })

    it('holds TrueFrame at 1: the conveyor slope $1CE is 15..0 deep, one column off at frame 0', () => {
      const at = (frame: number) => {
        const p = new Probe(freshRom(), 0x7)
        p.trueFrame = frame
        return measureTile(p, 0x1ce, cal).floor
      }
      expect(at(1)).toEqual(Array.from({ length: 16 }, (_, x) => 15 - x))
      expect(at(0)).not.toEqual(at(1))
      expect(new Probe(freshRom(), 0x7).trueFrame).toBe(1)
    })

    it('probing a tile that rewrites the cell does not blind the air table (call order)', () => {
      const p = new Probe(freshRom(), 0x105)
      measureTile(p, 0x2b, cal) // a coin: collecting it writes the cell
      expect([...probeAir(p).values()].filter(r => r.touched).length).toBeGreaterThan(0)
    })

    it('a second level of the same tileset gives what probing it fresh gives; a wrong tileset key does not', async () => {
      const [a, b] = [mapOf(0x105), mapOf(0x1c6)]
      expect(a.header.objectTileset).toBe(b.header.objectTileset)
      const t = a.header.objectTileset
      const fresh = await collisionLayer(freshRom(), 0x1c6, t, b.grid, new ProbeCache())
      const shared = new ProbeCache()
      await collisionLayer(freshRom(), 0x105, t, a.grid, shared)
      const reused = await collisionLayer(freshRom(), 0x1c6, t, b.grid, shared)
      if (!fresh.ok || !reused.ok) throw new Error('refused')
      expect(reused.probed).toBeLessThan(fresh.probed) // it really reused some
      expect(reused.lines).toEqual(fresh.lines)
      // The test can fail: $105's tiles served to $111 (tileset 1) as if they were tileset 1's differ in the
      // tiles themselves (hazard or solid), though not always in the lines.
      const c = mapOf(0x111)
      const right = new ProbeCache()
      expect((await collisionLayer(freshRom(), 0x111, 1, c.grid, right)).ok).toBe(true)
      const shown = (id: number) => JSON.stringify(shared.get(t, id))
      const differing = [...new Set(c.grid.flat())].filter(id => shared.get(t, id) && shown(id) !== JSON.stringify(right.get(1, id))) // prettier-ignore
      expect(differing.length).toBeGreaterThan(0)
    }, 120_000)
  })

  it('the blue P-switch turns coin $2B solid: collisionLayer in that state has a floor the off state lacks', async () => {
    const m = mapOf(0x10a) // holds coins; $2B acts as $32 while the switch runs (bank_00.asm:13423-13440)
    const ts = m.header.objectTileset
    const run = async (bluePs: boolean) => {
      const r = await collisionLayer(freshRom(), 0x10a, ts, m.grid, new ProbeCache(), { state: { flags: { green: false, yellow: false, blue: false, red: false }, bluePs } }) // prettier-ignore
      if (!r.ok) throw new Error(r.reason)
      return r.lines
    }
    const [off, on] = [await run(false), await run(true)]
    const covers = (lines: typeof off, x: number, y: number) =>
      lines.some(l => l.kind === 'floor' && l.points.filter((_, i) => i % 2).every(v => v === y * 16) && Math.min(...l.points.filter((_, i) => !(i % 2))) <= x * 16 && Math.max(...l.points.filter((_, i) => !(i % 2))) >= x * 16 + 16) // prettier-ignore
    const coins: [number, number][] = []
    m.grid.forEach((row, y) => row.forEach((id, x) => id === 0x2b && coins.push([x, y])))
    expect(coins.length).toBeGreaterThan(0)
    const solid = coins.filter(([x, y]) => covers(on, x, y) && !covers(off, x, y))
    expect(solid.length).toBeGreaterThan(0)
  }, 120_000)

  it('a pressed yellow palace turns the ghost "!" blocks of $015 solid: the grid and the lines follow', async () => {
    const flags = (yellow: boolean) => ({ yellow, green: false, red: false, blue: false })
    const rom = SmwRom.open(romPath(VANILLA))
    const grid = (yellow: boolean) => {
      const r = buildL1Inputs(rom, 0x15, flags(yellow))
      if (!r.ok) throw new Error(r.reason)
      return r.inputs
    }
    const [off, on] = [grid(false), grid(true)]
    const ts = off.header.objectTileset
    const layer = (m: typeof off, yellow: boolean) =>
      collisionLayer(freshRom(), 0x15, ts, m.grid, new ProbeCache(), { state: { flags: flags(yellow), bluePs: false } }) // prettier-ignore
    const [a, b] = [await layer(off, false), await layer(on, true)]
    if (!a.ok || !b.ok) throw new Error('refused')
    const cells: [number, number][] = []
    off.grid.forEach((row, y) =>
      row.forEach((id, x) => id !== on.grid[y]![x] && cells.push([x, y])),
    )
    expect(cells.length).toBe(7)
    expect(cells.every(([x, y]) => off.grid[y]![x] === 0x6b && on.grid[y]![x] === 0x16b)).toBe(true)
    expect(b.lines).not.toEqual(a.lines)
    // The "!" block ($16B) is solid: every changed cell has a floor line along its top in the on case, and not in the off case.
    const covers = (lines: typeof a.lines, x: number, y: number) =>
      lines.some(l => l.kind === 'floor' && l.points.filter((_, i) => i % 2).every(v => v === y * 16) && Math.min(...l.points.filter((_, i) => !(i % 2))) <= x * 16 && Math.max(...l.points.filter((_, i) => !(i % 2))) >= x * 16 + 16) // prettier-ignore
    for (const [x, y] of cells) {
      expect(covers(b.lines, x, y), `on ${x},${y}`).toBe(true)
      expect(covers(a.lines, x, y), `off ${x},${y}`).toBe(false)
    }
  }, 120_000)

  it('after every edit of a sequence, the incrementally kept cache gives what a cold probe gives', async () => {
    const level = 0x105
    const b0 = new Uint8Array(freshRom().buffer)
    const smw = new SmwRom(freshRom())
    const l1 = smw.getLevelL1Pointer(level)!
    const edits: [string, (r: ReturnType<typeof freshRom>) => void][] = [
      ['move a level object one tile', r => r.writeAt(l1 + 6, [r.readByte(l1 + 6)! ^ 0x01])],
      ['move another object a row', r => r.writeAt(l1 + 9, [r.readByte(l1 + 9)! ^ 0x10])],
      ['a byte no run reads', r => r.writeAt(0x0f8000, [r.readByte(0x0f8000)! ^ 0xff])],
      ...[0x00, 0x13, 0x2a, 0x37, 0x41].map((i): [string, (r: ReturnType<typeof freshRom>) => void] => [
        `a behaviour table byte +$${i.toString(16)}`,
        r => r.writeAt(0x00f05c + i, [r.readByte(0x00f05c + i)! ^ 0x04]),
      ]), // prettier-ignore
    ]
    let [before, cache] = [b0, new ProbeCache()]
    const grid = (b: Uint8Array) => {
      const r = buildL1Inputs(
        new SmwRom(RomFile.fromBytes(romPath(VANILLA), Buffer.from(b))),
        level,
        FLAGS,
      )
      if (!r.ok) throw new Error(r.reason)
      return r.inputs
    }
    const ask = async (b: Uint8Array, c: ProbeCache) => {
      const m = grid(b)
      const t0 = Date.now()
      const r = await collisionLayer(RomFile.fromBytes(romPath(VANILLA), Buffer.from(b)), level, m.header.objectTileset, m.grid, c) // prettier-ignore
      if (!r.ok) throw new Error(r.reason)
      return { r, ms: Date.now() - t0 }
    }
    const total = (await ask(b0, cache)).r.probed
    // Edits that really change one tile's behaviour: a byte only that tile's runs read (not the level of air's).
    const prep = (cache as any).preps.values().next().value
    const used = new Set<number>() // each edit its own byte: a second flip of one byte would undo the first
    const only = (id: number): number => {
      const d = (cache as any).tiles.get(`7:0:${id}`).deps.rom as number[]
      for (let i = 0; i < d.length; i += 2)
        for (let b = d[i]!; b < d[i + 1]!; b++)
          if (!used.has(b) && !rangesIntersect([b, b + 1], prep.deps.rom)) return (used.add(b), b)
      throw new Error(`tile $${id.toString(16)} reads nothing the air does not`)
    }
    // A byte only the level-of-air runs read: the shared calibration and air table go, and with them every tile.
    const entries = [...(cache as any).tiles.values()]
    const airOnly = ((): number => {
      for (let i = 0; i < prep.deps.rom.length; i += 2)
        for (let b = prep.deps.rom[i]; b < prep.deps.rom[i + 1]; b++)
          if (!entries.some(e => rangesIntersect([b, b + 1], e.deps.rom))) return b
      return prep.deps.rom[0]
    })()
    edits.push([`a byte only the level of air reads (file offset ${airOnly})`, r => (r.buffer[airOnly]! ^= 0x01)]) // prettier-ignore
    for (const id of [0x130, 0x1aa, 0x1c4]) {
      const at = only(id)
      edits.push([
        `a byte only tile $${id.toString(16)} reads (file offset ${at})`,
        r => (r.buffer[at]! ^= 0x01),
      ])
    }
    for (const [name, edit] of edits) {
      const rom = RomFile.fromBytes(romPath(VANILLA), Buffer.from(before))
      edit(rom)
      const after = new Uint8Array(rom.buffer)
      expect(changedRanges(before, after).length, name).toBeGreaterThan(0)
      cache = cache.migrate(changedRanges(before, after))
      const inc = await ask(after, cache)
      const fresh = await ask(after, new ProbeCache())
      expect(inc.r.lines, name).toEqual(fresh.r.lines)
      if (name.startsWith('a byte only')) expect(inc.r.dropped, name).toBeGreaterThan(0)
      if (name.includes('level of air'))
        expect(inc.r.dropped, name).toBeGreaterThanOrEqual(total) // the shared runs went: everything goes
      else expect(inc.r.dropped, name).toBeLessThan(total) // otherwise never the whole cache for one edit
      before = after
    }
  }, 300_000)

  describe('planted defects (the probe must go red)', () => {
    const cal = { foot: 32, head: 17 }
    const L = 0x105

    it('a BRK at the collision routine makes a tile unknown, and the layer refused', async () => {
      const rom = freshRom()
      rom.writeAt(0x00eadb, [0x00])
      expect(measureTile(new Probe(rom, L), 0x130, cal).unknown).toMatch(/BRK/)
      const m = mapOf(L)
      const r = await collisionLayer(rom, L, 7, m.grid, new ProbeCache())
      expect(r.ok).toBe(false)
      if (!r.ok) expect(r.reason).toMatch(/BRK|calibration/)
    }, 120_000)

    it('a zeroed slope table changes a slope floor: the ROM table is what is read', () => {
      const real = measureTile(new Probe(freshRom(), L), 0x1bf, cal)
      const rom = freshRom()
      rom.writeAt(0x00e632, new Array(0x1f0).fill(0))
      const flat = measureTile(new Probe(rom, L), 0x1bf, cal)
      expect(new Set(real.floor).size).toBeGreaterThan(3)
      expect(flat.floor).not.toEqual(real.floor)
    })

    it('a block that kills on touch from above still has its floor (HurtMario leaves no landing flag)', () => {
      const rom = freshRom()
      // The top-of-block hit (JSL CODE_00F120 at $00EE7F) pointed at HurtMario (CODE_00F5B7).
      rom.writeAt(0x00ee7f, [0x22, 0xb7, 0xf5, 0x00])
      const t = measureTile(new Probe(rom, L), 0x130, cal)
      expect(t.hurt).toBe(true)
      expect(t.floor).toEqual(Array(16).fill(0))
    })
  })
})
