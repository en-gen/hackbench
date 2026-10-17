/**
 * #911: `entryDy` read an unreadable entrance-table byte as 0, so a ROM cut short drew layer 2 at
 * a made-up height with no word of it. It must refuse in plain words instead. Synthetic ROM bytes
 * only (the bytes are built here); no corpus, so the counts are the same with and without one.
 */
import { describe, it, expect, vi } from 'vitest'
import { buildL2Inputs } from '../../../src/rom/model/L2Model'
import type { L1Inputs } from '../../../src/rom/model/L1Model'
import type { MapEntrances, SmwRom } from '../../../src/rom/SmwRom'
import type { RomFile } from '../../../src/rom/RomFile'
import { modeTablesRom, STANDARD } from '../support/l3Rom'
import { plantUploaderTable } from '../support/l2UploaderRom'
import { writeStockSkipChain } from '../support/skipChain'

const MAP = 5
const ID = 0x1c3
const L1_Y = [0x10, 0x60, 0xc0, 0x30]
const L2_Y = [0x08, 0x28, 0x48, 0x68]
// Every table byte entryDy reads here (the L1/L2 rows the F400 and FA00 bits select), all four paths (overworld, exit, midway, secondary).
const TABLE_ADDRS = [0x05f400 + MAP, 0x05fa00 + ID, 0x05d70a, 0x05d70b, 0x05d70d, 0x05d70e, 0x05f600 + MAP, 0x05fc00 + ID, 0x05d710, 0x05f000 + MAP] // prettier-ignore
const VIA: MapEntrances = { overworld: true, primary: true, secondary: [ID] }
// No exit graph: what a ROM cut before DATA_05F800 gives (readMapEntrances is then undefined), so
// the fallback reads F400/F600/F000 and the D70x rows they select.
const FALLBACK_ADDRS = [0x05f400 + MAP, 0x05d70b, 0x05d70e, 0x05f600 + MAP, 0x05f000 + MAP, 0x05d710] // prettier-ignore
const CASES = [
  { name: 'with entrances', via: VIA as MapEntrances | null, addrs: TABLE_ADDRS },
  { name: 'without entrances (exit graph unavailable)', via: null, addrs: FALLBACK_ADDRS },
]
const REFUSAL = /ROM ends before the entrance tables/

function build(): RomFile {
  const rom = modeTablesRom([STANDARD, ...Array(31).fill(STANDARD)])
  rom.writeAt(0x05d708, L1_Y)
  rom.writeAt(0x05d70c, L2_Y)
  rom.writeAt(0x05f400 + MAP, [0x1e]) // DisableMidway nonzero, so the midway path is read too
  rom.writeAt(0x05fa00 + ID, [0x64])
  rom.writeAt(0x05f600 + MAP, [0x22]) // vertical ScreenMode, so the high-byte tables are read
  rom.writeAt(0x05fc00 + ID, [0x03])
  rom.writeAt(0x05e600 + MAP * 3, [0x00, 0xe9, 0x05]) // an L2 object stream in bank 5 (zeros: an empty one), below every cut
  rom.writeAt(0x05803b, [0xc9]) // the stock L2 preset check
  plantUploaderTable(rom)
  writeStockSkipChain(rom)
  return rom
}

function l2Of(rom: RomFile, via: MapEntrances | null = VIA) {
  const smw = { rom, getVerticalTable: () => ({ ok: true, table: new Array(32).fill(0) }) }
  const l1 = { screenCount: 1, isVertical: false, header: { levelMode: 1, objectTileset: 0 }, map16: { tiles: [] } } as unknown as L1Inputs // prettier-ignore
  return buildL2Inputs(smw as unknown as SmwRom, MAP, l1, via ?? undefined, () => null)
}

describe.each(CASES)(
  'an unreadable entrance-table byte refuses layer 2 instead of reading 0, $name (#911)',
  ({ via, addrs }) => {
    it('control: the full synthetic ROM draws', () => {
      expect(l2Of(build(), via).ok).toBe(true)
    })

    it.each(addrs.map(a => [`$${a.toString(16)}`, a] as const))(
      'the byte at %s unreadable refuses in plain words',
      (_name, addr) => {
        const rom = build()
        const real = rom.readByte.bind(rom)
        vi.spyOn(rom, 'readByte').mockImplementation(a => (a === addr ? null : real(a)))
        const r = l2Of(rom, via)
        expect(r.ok).toBe(false)
        if (!r.ok) expect(r.reason).toMatch(REFUSAL)
      },
    )

    // A real cut of the buffer cannot isolate these tables: the planted uploader chain (banks 6-7)
    // sits above them and would be lost first. So the tail of bank 5 is made unreadable instead, from
    // each address past the L2 stream up to the last table byte: what a cut there leaves. The tables
    // below the pointer (D70x) are covered one by one above.
    it('a sweep over truncation points refuses at each cut that loses a needed byte', () => {
      const lastNeeded = Math.max(...addrs)
      let refused = 0
      let drawn = 0
      for (let cut = 0x05e950; cut <= lastNeeded + 8; cut++) {
        const rom = build()
        const real = rom.readByte.bind(rom)
        vi.spyOn(rom, 'readByte').mockImplementation(a =>
          a >= cut && a <= 0x05ffff ? null : real(a),
        )
        const r = l2Of(rom, via)
        const lost = addrs.some(a => a >= cut)
        expect(r.ok, `cut ${cut.toString(16)}`).toBe(!lost)
        if (!r.ok) expect(r.reason, `cut ${cut.toString(16)}`).toMatch(REFUSAL)
        if (lost) refused++
        else drawn++
      }
      expect(refused).toBeGreaterThan(1000) // the sweep ran: not a loop over nothing
      expect(drawn).toBeGreaterThan(0)
    })
  },
)

describe('DisableMidway is read only when the overworld path is in play (#911)', () => {
  it('a secondary-only map still draws with F400 unreadable', () => {
    const rom = build()
    const real = rom.readByte.bind(rom)
    vi.spyOn(rom, 'readByte').mockImplementation(a => (a === 0x05f400 + MAP ? null : real(a)))
    // secondary row only: FA00 and FC00 give the height, F400 is never consulted by entryDy
    expect(l2Of(rom, { overworld: false, primary: false, secondary: [ID] }).ok).toBe(true)
  })
})
