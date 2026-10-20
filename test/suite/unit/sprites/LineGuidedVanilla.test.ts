/**
 * Every vanilla placement of the line-guided sprites ($62, $64-$68) on the vanilla ROM, run two ways: INIT-on (play and
 * simulate, where the line-walk pick applies, #126/#792) and at rest (the map's picture, R16). The numbers are what the
 * runner gave on 2026-10-20 (one machine, vanilla US ROM); each table is a plant: a gate or pick that changes goes red.
 * Compared with the generic rule by running the same placement with the gate switched off (a shape that names no routine).
 */
import { readFileSync } from 'node:fs'
import { describe, expect, it } from 'vitest'
import { L1ModelCache } from '../../../../theia/extension/src/node/map-screen'
import { interpDrawer, readStream } from '../../../../theia/extension/src/node/map-sprites'
import { parseLevelSprites } from '../../../../src/rom/LevelParser'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { VANILLA_DISPATCH } from '../../../../src/rom/sprites/interp/LineGuided'
import { runOnce, type SpriteModel } from '../../../../src/rom/sprites/interp/SpriteRunner'
import { hasRom, romPath, VANILLA } from '../../support/corpus'

const IDS = [0x62, 0x64, 0x65, 0x66, 0x67, 0x68]
/** Maps (decimal) holding a line-guided sprite on the vanilla ROM, found by sweeping all 512 sprite streams. */
const MAPS = [5, 15, 26, 31, 221, 298, 300]
const OFF = { ...VANILLA_DISPATCH, routines: {}, byId: {} }
/** Where a straight line tile draws its line in its 16x16 cell: $90 at x 0, $91 at x 15, $92 at y 0, $93 at y 15. */
const EDGE: Record<number, (x: number, y: number) => boolean> = {
  0x90: x => x === 0,
  0x91: x => x === 15,
  0x92: (_, y) => y === 0,
  0x93: (_, y) => y === 15,
}

interface Row {
  slot: number
  id: number
  x: number
  y: number
  play: SpriteModel
  playOff: SpriteModel
  rest: SpriteModel
  restOff: SpriteModel
  tile: number | undefined
}

const rows = (): Row[] => {
  const path = romPath(VANILLA)
  const bytes = new Uint8Array(readFileSync(path))
  const rom = new SmwRom(RomFile.fromBytes(path, Buffer.from(bytes)))
  const found: number[] = []
  for (let slot = 0; slot < 0x200; slot++) {
    const ptr = rom.getLevelSpritePointer(slot)
    if (ptr !== null && parseLevelSprites(readStream(rom.rom, ptr), false).some(x => IDS.includes(x.spriteId))) found.push(slot) // prettier-ignore
  }
  // Discovery by the streams of all 512 maps, so a map the list above misses fails here.
  expect(found).toEqual(MAPS)
  const out: Row[] = []
  for (const slot of MAPS) {
    const built = new L1ModelCache().get(bytes, path, slot, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
    if (!built.ok) throw new Error(built.reason)
    const grid = built.inputs.grid as number[][]
    const list = parseLevelSprites(readStream(rom.rom, rom.getLevelSpritePointer(slot)!), built.inputs.isVertical).filter(x => IDS.includes(x.spriteId)) // prettier-ignore
    for (const p of list) {
      const take = (opts: Parameters<typeof runOnce>[3]) => {
        let m: SpriteModel | undefined
        interpDrawer(rom.rom, slot, built.inputs, (r, id, sd) => (m = runOnce(r, id, sd, opts)))(p)
        return m!
      }
      const play = take({})
      const a = play.anchor
      out.push({
        slot, id: p.spriteId, x: p.x * 16, y: p.y * 16, play,
        playOff: take({ grinderDispatch: OFF }),
        rest: take({ atRest: true }),
        restOff: take({ atRest: true, grinderDispatch: OFF }),
        tile: a ? grid[a.y >> 4]?.[a.x >> 4] : undefined,
      }) // prettier-ignore
    }
  }
  return out
}

const sorted = (v: number[]) => [...new Set(v)].sort((a, b) => a - b)
const topLeft = (m: SpriteModel): [number, number] => {
  const q = m.passes[m.chosen!]!
  return [m.anchor!.x + Math.min(...q.parts.map(t => t.dx)), m.anchor!.y + Math.min(...q.parts.map(t => t.dy))] // prettier-ignore
}

describe.skipIf(!hasRom(VANILLA))('every vanilla line-guided placement (#792)', () => {
  // Built on first use, not when the file loads: without the corpus the describe is skipped and must not run the sweep.
  let cache: Row[] | undefined
  const table = () => (cache ??= rows())
  const of = (id: number) => table().filter(r => r.id === id)

  it('INIT-on: how many the line pick moves from the generic rule, and by how much', () => {
    const got = Object.fromEntries(
      IDS.map(id => {
        const moved = of(id).filter(r => r.play.anchor!.x !== r.playOff.anchor!.x || r.play.anchor!.y !== r.playOff.anchor!.y) // prettier-ignore
        return [id, {
          total: of(id).length,
          moved: moved.length,
          dx: sorted(moved.map(r => r.play.anchor!.x - r.playOff.anchor!.x)),
          dy: sorted(moved.map(r => r.play.anchor!.y - r.playOff.anchor!.y)),
        }]
      }),
    ) // prettier-ignore
    expect(got).toEqual({
      0x62: { total: 6, moved: 4, dx: [0, 15], dy: [0, 5, 15] },
      0x64: { total: 12, moved: 0, dx: [], dy: [] },
      0x65: { total: 32, moved: 24, dx: [-15, 0, 16], dy: [0, 15] },
      0x66: { total: 1, moved: 1, dx: [16], dy: [0] },
      0x67: { total: 20, moved: 17, dx: [-15, 0, 1, 16], dy: [0, 15] },
      0x68: { total: 37, moved: 28, dx: [0, 11, 16], dy: [0, 4, 15] },
    })
  }, 600_000)

  it('INIT-on: each one the pick moved sits on a line tile (Map16 $76-$99), and on a straight one at its edge', () => {
    for (const r of table()) {
      const [a, b] = [r.play.anchor!, r.playOff.anchor!]
      if (a.x === b.x && a.y === b.y) continue
      const where = `slot ${r.slot} id $${r.id.toString(16)} (${a.x},${a.y}) tile $${r.tile?.toString(16)}`
      expect(r.tile !== undefined && r.tile >= 0x76 && r.tile <= 0x99, where).toBe(true)
      const on = EDGE[r.tile!]
      if (on) expect(on(a.x & 15, a.y & 15), where).toBe(true)
    }
  })

  it('INIT-on: all 12 $64 ropes sit on the top edge of a $92 line tile, where the generic rule put them (D85 call 1)', () => {
    const ropes = of(0x64)
    expect(ropes).toHaveLength(12)
    for (const r of ropes) {
      expect([r.tile, r.play.anchor!.y & 15], `slot ${r.slot}`).toEqual([0x92, 0])
      expect(r.play.anchor).toEqual(r.playOff.anchor)
    }
  })

  it("at rest: the picture stands on the run's own post-INIT spot: 320 px left (even column) or 15 px right (odd) for $65-$68; $62 and the 12 $64 ropes, already on their line, do not move", () => {
    for (const r of table()) {
      const want = r.id >= 0x65 ? [r.x & 0x10 ? 15 : -320, 0] : [0, 0]
      expect(
        [r.rest.anchor!.x - r.x, r.rest.anchor!.y - r.y],
        `slot ${r.slot} id $${r.id.toString(16)}`,
      ).toEqual(want)
      expect(r.rest.shifted === true, `slot ${r.slot} id $${r.id.toString(16)}`).toBe(want[0] !== 0)
    }
  })

  it('at rest: the gate changes where the picture sits from its anchor by the pass-before origin, not by the shift', () => {
    // The picture's top-left with the gate on, minus with it off, minus what INIT moved: the origin change alone.
    const tally = Object.fromEntries(
      IDS.map(id => {
        const c: Record<string, number> = {}
        for (const r of of(id)) {
          const [on, off] = [topLeft(r.rest), topLeft(r.restOff)]
          const key = [on[0] - off[0] - (r.rest.anchor!.x - r.x), on[1] - off[1] - (r.rest.anchor!.y - r.y)].join(',') // prettier-ignore
          c[key] = (c[key] ?? 0) + 1
        }
        return [id, c]
      }),
    )
    expect(tally).toEqual({
      0x62: { '4,4': 6 },
      0x64: { '0,0': 12 },
      0x65: { '4,4': 26, '0,0': 1, '-4,4': 5 },
      0x66: { '4,4': 1 },
      0x67: { '4,4': 12, '-4,4': 8 },
      0x68: { '-4,4': 16, '4,4': 20, '0,0': 1 },
    })
  })
})
