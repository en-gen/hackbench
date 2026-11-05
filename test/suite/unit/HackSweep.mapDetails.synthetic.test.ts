/**
 * The hack sweep's mapDetails reader goes red when a per-map reader throws, and says how many
 * maps did. Built from a synthetic in-memory ROM: no ROM bytes, nothing mocked but the one
 * method the plant replaces.
 */
import { describe, it, expect, vi } from 'vitest'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { readers } from '../../../tools/scripts/hack-sweep'

/** One real map, slot $105: LoROM header, an L1 pointer, a header and one object. */
function syntheticRom(): SmwRom {
  const buf = Buffer.alloc(0x40000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('synthetic.sfc', buf)
  rom.writeAt(ADDR.ROM_NAME, Buffer.from('HACKBENCH SYNTHETIC  ', 'ascii'))
  rom.writeAt(ADDR.LEVEL_L1_PTR + 0x105 * 3, [0x00, 0x80, 0x06])
  rom.writeAt(0x068000, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x35, 0x01, 0xff])
  return new SmwRom(rom)
}

describe('hack-sweep mapDetails reader', () => {
  it('reports ok over the real maps when nothing throws', () => {
    const outcome = readers(syntheticRom()).mapDetails!()
    expect(outcome).toMatchObject({ verdict: 'ok' })
    expect(outcome.verdict === 'ok' && outcome.summary).toMatch(/^[1-9]\d* maps open$/)
  })

  it('throws "N of M maps throw" naming the slot when a per-map read throws (planted)', () => {
    const smw = syntheticRom()
    // The catalog reads the same methods first, so the plant arms only when the reader's own
    // per-map loop starts (it asks for the vertical table just before it).
    let armed = false
    const table = smw.getVerticalTable.bind(smw)
    vi.spyOn(smw, 'getVerticalTable').mockImplementation(() => {
      armed = true
      return table()
    })
    const pointer = smw.getLevelSpritePointer.bind(smw)
    vi.spyOn(smw, 'getLevelSpritePointer').mockImplementation(i => {
      if (armed && i === 0x105) throw new RangeError('planted')
      return pointer(i)
    })
    expect(() => readers(smw).mapDetails!()).toThrow(/^1 of \d+ maps throw \(\$105\): planted/)
  })
})
