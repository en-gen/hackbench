/**
 * #861: the drawn layer 2 height (L2Model) and the layer 3 camera (L3Model) pick their entrance
 * with the one `chooseEntrance`. They used to split on a secondary-only map whose first listed
 * entrance is not the lowest: L2 drew the first listed, L3 used the lowest. (The exit graph sorts
 * the list, SmwRom.ts:565, so no ROM shows this; the lists below are built to be unsorted.) Synthetic ROM bytes, hand-written
 * expectations; no corpus.
 */
import { describe, it, expect } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { buildL2Inputs } from '../../../src/rom/model/L2Model'
import type { L1Inputs } from '../../../src/rom/model/L1Model'
import { buildL3Verdict } from '../../../src/rom/model/L3Model'
import { parseLevelHeader } from '../../../src/rom/LevelParser'
import type { MapEntrances, SmwRom } from '../../../src/rom/SmwRom'
import { modeTablesRom, STANDARD, withLayer3 } from '../support/l3Rom'
import { plantUploaderTable } from '../support/l2UploaderRom'
import { writeStockSkipChain } from '../support/skipChain'

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
const camRom = () => {
  const rom = withLayer3(tables(modeTablesRom([STANDARD, ...Array(31).fill(STANDARD)])), { level: MAP, tileset: 0, setting: 2, settingsByte: 0x02, word: 0x0002 }) // prettier-ignore
  rom.writeAt(0x05e600 + MAP * 3, [0x00, 0x80, 0x07]) // an L2 object stream (zeros: an empty one)
  rom.writeAt(0x05803b, [0xc9]) // the stock L2 preset check
  plantUploaderTable(rom)
  writeStockSkipChain(rom)
  return rom
}
const l1 = { header: parseLevelHeader(Uint8Array.from([0, 0, 0, 0, 0])), isVertical: false, colors: [] } as never // prettier-ignore
const camY = (via: MapEntrances) => buildL3Verdict(camRom(), MAP, l1, { ok: true, mode: 1 }, () => [[]] as never, { ok: true }, undefined, via).l3?.camYPx // prettier-ignore
/** The drawn layer 2 height and its map note, through the public builder. */
function drawn(via: MapEntrances): { dy: number; note?: string } {
  const smw = {
    rom: camRom(),
    getVerticalTable: () => ({ ok: true, table: new Array(32).fill(0) }),
  }
  const l1In = { screenCount: 1, isVertical: false, header: { levelMode: 1, objectTileset: 0 }, map16: { tiles: [] } } as unknown as L1Inputs // prettier-ignore
  const r = buildL2Inputs(smw as unknown as SmwRom, MAP, l1In, via, () => null)
  if (!r.ok) throw new Error(r.reason)
  return { dy: r.l2.dy, note: r.l2.note }
}
const ids = Object.keys(ROWS).map(Number)
const LOWEST_FIRST = (list: number[]) => Math.min(...list) // hard-coded rule, not chooseEntrance

describe('one entrance chooser for the layer 2 height and the layer 3 camera (#861)', () => {
  it('a secondary-only map listed [B, A] with A < B: L2 draws, and L3 reads, row A', () => {
    const via: MapEntrances = { overworld: false, primary: false, secondary: [0x1c5, 0x1c3] }
    expect(drawn(via).dy).toBe(dyOf(ROWS[0x1c3]!))
    expect(camY(via)).toBe(L1_Y[ROWS[0x1c3]![0]!])
    // the note names the drawn entrance, then the ones that disagree with it
    expect(drawn(via).note).toMatch(
      /drawn as entered through secondary entrance \$1C3; entered .*\$1C5/,
    )
  })

  it('a primary entry is drawn ahead of any secondary one, and the note leads with it', () => {
    const via: MapEntrances = { overworld: true, primary: true, secondary: [0x1c3] }
    expect(drawn(via).dy).toBe(dyOf(PRIMARY_ROW))
    expect(drawn(via).note).toMatch(/drawn as entered from the overworld/)
  })

  const orders = (xs: number[]): number[][] =>
    xs.length <= 1 ? [xs] : xs.flatMap((x, i) => orders([...xs.slice(0, i), ...xs.slice(i + 1)]).map(r => [x, ...r])) // prettier-ignore
  const subsets = (xs: number[]): number[][] =>
    xs.reduce<number[][]>((acc, x) => [...acc, ...acc.map(s => [...s, x])], [[]])
  const vias: MapEntrances[] = subsets(ids)
    .flatMap(orders)
    .flatMap(
      secondary =>
    [false, true].flatMap(overworld => [false, true].map(primary => ({ overworld, primary, secondary }))), // prettier-ignore
    )
  // 16 ordered lists (1 + 3 + 6 + 6) x 4 flag pairs. The expectation is hard-coded, not read back
  // from chooseEntrance: a primary entry draws the primary row, a secondary-only map the row of its
  // lowest id; and where both views apply (secondary-only) the camera must name that same row.
  it('sweep: all 64 via shapes draw the primary row, or the lowest secondary id, as the camera does', () => {
    expect(vias).toHaveLength(64)
    for (const via of vias) {
      const label = JSON.stringify(via)
      const primaryEntry = via.overworld || via.primary
      const row = primaryEntry ? PRIMARY_ROW : via.secondary.length ? ROWS[LOWEST_FIRST(via.secondary)]! : PRIMARY_ROW // prettier-ignore
      expect(drawn(via).dy, label).toBe(dyOf(row))
      if (!primaryEntry && via.secondary.length) expect(camY(via), label).toBe(L1_Y[row[0]!])
    }
  })
})
