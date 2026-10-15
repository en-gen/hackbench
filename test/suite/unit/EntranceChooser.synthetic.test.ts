/**
 * #861: the drawn layer 2 height (L2Model) and the layer 3 camera (L3Model) pick their entrance
 * with the one `chooseEntrance`. They used to split on a secondary-only map whose entrance list is
 * not ascending: L2 drew the first listed, L3 used the lowest. Synthetic ROM bytes, hand-written
 * expectations; no corpus.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { chooseEntrance } from '../../../src/rom/L3Loader'
import { dyFromEntrances } from '../../../src/rom/model/L2Model'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import type { MapEntrances } from '../../../src/rom/SmwRom'
import { modeTablesRom, STANDARD, withLayer3 } from '../support/l3Rom'

const L1_Y = [0x10, 0x60, 0xc0, 0x30]
const L2_Y = [0x08, 0x28, 0x48, 0x68]
const MAP = 5
// Entrance id -> [L1 index, L2 index] of its DATA_05FA00 row; every row gives a different dy.
const ROWS: Record<number, [number, number]> = { 0x1c3: [1, 3], 0x1c4: [0, 0], 0x1c5: [2, 1] }
const PRIMARY_ROW = [3, 2] // F400 bits 3-2 / 1-0
const dyOf = ([a, b]: number[]) => L1_Y[a!]! - L2_Y[b!]!

function tables(rom: RomFile): RomFile {
  rom.writeAt(0x05d708, L1_Y)
  rom.writeAt(0x05d70c, L2_Y)
  rom.writeAt(0x05f400 + MAP, [(PRIMARY_ROW[0]! << 2) | PRIMARY_ROW[1]!])
  for (const [id, [a, b]] of Object.entries(ROWS)) rom.writeAt(0x05fa00 + Number(id), [(b << 6) | (a << 4)]) // prettier-ignore
  return rom
}
const world = () => tables(new RomFile('x.sfc', Buffer.alloc(0x80000, 0)))
const camRom = () =>
  withLayer3(tables(modeTablesRom([STANDARD, ...Array(31).fill(STANDARD)])), { level: MAP, tileset: 0, setting: 2, settingsByte: 0x02, word: 0x0002 }) // prettier-ignore
const l1 = { header: parseLevelHeader(Uint8Array.from([0, 0, 0, 0, 0])), isVertical: false, colors: [] } as never // prettier-ignore
const camY = (via: MapEntrances) => buildL3Verdict(camRom(), MAP, l1, { ok: true, mode: 1 }, () => [[]] as never, { ok: true }, undefined, via).l3?.camYPx // prettier-ignore

describe('one entrance chooser for the layer 2 height and the layer 3 camera (#861)', () => {
  it('a secondary-only map listed [B, A] with A < B: L2 draws, and L3 reads, row A', () => {
    const via: MapEntrances = { overworld: false, primary: false, secondary: [0x1c5, 0x1c3] }
    expect(dyFromEntrances(world(), MAP, via)?.dy).toBe(dyOf(ROWS[0x1c3]!))
    expect(camY(via)).toBe(L1_Y[ROWS[0x1c3]![0]!])
    // the note names the drawn entrance, then the ones that disagree with it
    expect(dyFromEntrances(world(), MAP, via)?.note).toMatch(
      /drawn as entered through secondary entrance \$1C3; entered .*\$1C5/,
    )
  })

  const orders = (ids: number[]): number[][] =>
    ids.length <= 1 ? [ids] : ids.flatMap((id, i) => orders([...ids.slice(0, i), ...ids.slice(i + 1)]).map(r => [id, ...r])) // prettier-ignore
  const subsets = (ids: number[]): number[][] =>
    ids.reduce<number[][]>((acc, id) => [...acc, ...acc.map(s => [...s, id])], [[]])
  const lists = subsets(Object.keys(ROWS).map(Number)).flatMap(orders)
  const vias: MapEntrances[] = lists.flatMap(
    secondary =>
    [false, true].flatMap(overworld => [false, true].map(primary => ({ overworld, primary, secondary }))), // prettier-ignore
  )
  // 16 ordered lists (1 + 3 + 6 + 6) x 4 flag pairs; a loop over an empty array must not pass.
  it('sweep: all 64 via shapes draw the entrance chooseEntrance names', () => {
    expect(vias).toHaveLength(64)
    for (const via of vias) {
      const chosen = chooseEntrance(via)
      const got = dyFromEntrances(world(), MAP, via)
      const label = JSON.stringify(via)
      if (chosen === null && !via.overworld && !via.primary) {
        expect(got, label).toBeNull() // no entrance reaches the map: nothing drawn
      } else {
        expect(got?.dy, label).toBe(dyOf(chosen === null ? PRIMARY_ROW : ROWS[chosen]!))
      }
      if (via.secondary.length > 0 && !via.overworld && !via.primary) {
        expect(camY(via), label).toBe(L1_Y[ROWS[chosen!]![0]!]) // the camera agrees
      }
    }
  })
})
