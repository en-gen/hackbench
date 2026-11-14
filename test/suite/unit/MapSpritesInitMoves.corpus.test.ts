/**
 * #1231 on the vanilla ROM: every sprite is drawn where its INIT leaves it, and the map keeps its list entry as
 * `stored` (Decision 2026-11-14). Corpus tests only (`describe.skipIf`), so CI without the ROM registers them as skipped.
 */
import { describe, it, expect } from 'vitest'
import { parseLevelSprites } from '../../../src/rom/LevelParser'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom } from '../../../src/rom/SmwRom'
import { mapSprites } from '../../../theia/extension/src/node/map-sprites'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'
import { storedCell, storedSquares } from '../../../theia/extension/src/browser/map-view-model'
import type { MapSpriteDto } from '../../../theia/extension/src/common/project-protocol'
import { VANILLA, hasRom, romPath } from '../support/corpus'
import { slow } from '../support/loadTimeout'

describe.skipIf(!hasRom(VANILLA))('INIT moves are drawn on vanilla maps (#1231)', () => {
  const bytes = () => new Uint8Array(RomFile.load(romPath(VANILLA)).buffer)
  const served = (b: Uint8Array, map: number) => {
    const r = mapSprites(new L1ModelCache(), b, romPath(VANILLA), map)
    if (r.status !== 'ok') throw new Error(`map ${map}: ${r.status}`)
    return r.sprites
  }
  const tryServed = (b: Uint8Array, map: number) => {
    const r = mapSprites(new L1ModelCache(), b, romPath(VANILLA), map)
    return r.status === 'ok' ? r.sprites : undefined
  }
  const list = (b: Uint8Array, map: number) => {
    const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
    const ptr = rom.getLevelSpritePointer(map)
    if (ptr === null) return []
    const built = new L1ModelCache().get(b, romPath(VANILLA), map, { yellow: false, green: false, red: false, blue: false }) // prettier-ignore
    if (!built.ok) throw new Error(built.reason)
    return parseLevelSprites(rom.rom.readUpTo(ptr, 0x200)!, built.inputs.isVertical)
  }

  it('$105: the three $4F draw at the list position plus (+8, -1)', () => {
    const b = bytes()
    const mine = served(b, 0x105).filter(s => s.id === 0x4f)
    const entries = list(b, 0x105).filter(s => s.spriteId === 0x4f)
    expect(mine).toHaveLength(3)
    expect(mine.map(s => [s.x, s.y])).toEqual(entries.map(s => [s.x * 16 + 8, s.y * 16 - 1]))
    expect(mine.map(s => s.stored)).toEqual(entries.map(s => ({ x: s.x * 16, y: s.y * 16 })))
  })

  // InitBrwnChainPlat adds $78 to X and $68 to Y (SMWDisX bank_01.asm:9705-9718).
  it.each([0x103, 0x0d7])(
    'map %i: every $5F draws its swing around its stored position plus (+120, +104)',
    map => {
      const b = bytes()
      const mine = served(b, map).filter(s => s.id === 0x5f)
      const entries = list(b, map).filter(s => s.spriteId === 0x5f)
      expect(mine.length).toBeGreaterThan(0)
      expect(mine).toHaveLength(entries.length)
      for (const [i, s] of mine.entries()) {
        const [sx, sy] = [entries[i]!.x * 16, entries[i]!.y * 16]
        expect([s.x, s.y], `$5F #${i}`).toEqual([sx + 120, sy + 104])
        expect(s.stored).toEqual({ x: sx, y: sy })
        // The swing hangs from that spot: its art's center stays within 96 px of it. The old re-base drew it 120 px left and
        // 104 px up of the block it hangs from.
        const [cx, cy] = [(s.box.x0 + s.box.x1) / 2, (s.box.y0 + s.box.y1) / 2]
        expect(Math.abs(cx - s.x), `$5F #${i} center x`).toBeLessThanOrEqual(96)
        expect(Math.abs(cy - s.y), `$5F #${i} center y`).toBeLessThanOrEqual(96)
      }
    },
  )

  // The review's find: on vertical maps the loader spawns a sprite outside GetDrawInfo's window, so an empty spawn run is not
  // "behind the scroll". These eight (a $6C and a $0E, static) were marked "never appears in play" on that reading.
  it.each([
    [0x109, [0, 1, 17, 18]],
    [0x12a, [1, 4, 6]],
    [0x134, [1]],
  ] as const)(
    'vertical map %i: indexes %j are drawn moved, not marked never appears',
    (map, idx) => {
      const got = served(bytes(), map)
      for (const i of idx) {
        const s = got.find(q => q.index === i)!
        expect(s.stored, `#${i} stored`).toBeDefined()
        expect(s.note, `#${i} note`).toBeUndefined()
      }
    },
  )

  // 512 maps, one machine; the table of how many sprites move and by how much is printed for the PR.
  it(
    'all 512 maps: the stored position (stored, else x and y) of every sprite equals its list entry',
    slow(900_000),
    () => {
      const b = bytes()
      let sprites = 0
      let squaresShown = 0
      const unavailable: number[] = []
      const moved = new Map<string, { n: number; deltas: Set<string> }>()
      for (let map = 0; map < 0x200; map++) {
        const rom = new SmwRom(RomFile.fromBytes('x.sfc', Buffer.from(b)))
        if (rom.getLevelSpritePointer(map) === null) continue
        const got = tryServed(b, map)
        if (!got) {
          unavailable.push(map)
          continue
        }
        const dtos = new Map<number, MapSpriteDto>(got.map(s => [s.index, s]))
        const entries = list(b, map)
        for (const d of storedSquares(got)) {
          const e = entries.find(q => q.index === d.index)!
          expect([storedCell(d)!.x0, storedCell(d)!.y0], `square of #${d.index}`).toEqual([e.x * 16, e.y * 16]) // prettier-ignore
          squaresShown++
        }
        for (const e of entries) {
          const d = dtos.get(e.index)
          // A sprite the sweep could not serve at all has no reply to compare; the count below shows none are missing.
          if (!d) continue
          sprites++
          const at = d.stored ?? { x: d.x, y: d.y }
          expect([at.x, at.y], `map $${map.toString(16)} index ${e.index} id $${e.spriteId.toString(16)}`).toEqual([e.x * 16, e.y * 16]) // prettier-ignore
          // The marker's cell, from the production function, is the list entry's own tile: 16 x 16 at its position.
          const cell = storedCell(d)
          if (d.stored) {
            expect(cell, `map $${map.toString(16)} index ${e.index} marker cell`).toEqual({ x0: e.x * 16, y0: e.y * 16, x1: e.x * 16 + 16, y1: e.y * 16 + 16 }) // prettier-ignore
          } else expect(cell).toBeUndefined()
          if (d.stored) {
            const k = `$${d.id.toString(16).toUpperCase().padStart(2, '0')}`
            const row = moved.get(k) ?? { n: 0, deltas: new Set<string>() }
            row.n++
            row.deltas.add(`${d.x - d.stored.x},${d.y - d.stored.y}`)
            moved.set(k, row)
          }
        }
      }
      console.log(
        `#1231 sweep: ${unavailable.length} maps with no sprite reply: ${unavailable.map(m => '$' + m.toString(16)).join(' ')}`,
      )
      const total = [...moved.values()].reduce((a, r) => a + r.n, 0)
      console.log(
        `#1231 sweep: ${sprites} sprites compared, ${total} drawn off their stored tile, ${squaresShown} with a dashed square (the drawing does not cover the cell)`,
      )
      for (const [k, r] of [...moved].sort())
        console.log(`  ${k}: ${r.n} moved by ${[...r.deltas].sort().join(' | ')}`)
      expect(sprites).toBeGreaterThan(1000)
      expect(total).toBeGreaterThan(0)
    },
  )
})
