/**
 * #781: the model build refuses when Mario's start position cannot be read (no ROM: the cart is built
 * here). A zero default would put Mario on screen 0 and pass for a real start.
 */
import { describe, it, expect, vi } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom } from '../../../../src/rom/SmwRom'
import { buildMapWithGraph } from '../../../../src/rom/model/MapBuilder'

// The collaborators that read engine code a blank cart lacks (Map16 tables, GFX paths) are not under
// test; the Mario guard sits after them.
vi.mock('../../../../src/rom/ObjectExpander', async orig => ({ ...(await orig<object>()), expandMap: () => [] })) // prettier-ignore
vi.mock('../../../../src/rom/model/tiles/TileFactory', async orig => ({ ...(await orig<object>()), buildTiles: () => new Map() })) // prettier-ignore
vi.mock('../../../../src/rom/model/L2Factory', async orig => ({ ...(await orig<object>()), buildBgTiles: () => new Map() })) // prettier-ignore

// Level header (5 bytes, mode 0, length 1 screen) and an end-of-objects marker.
const LEVEL = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0xff])

/** An SmwRom over a blank LoROM cart whose level data and vertical table are supplied, nothing else. */
function cart(withheld?: number): SmwRom {
  const bytes = Buffer.alloc(0x100000)
  const real = RomFile.fromBytes('blank.sfc', bytes)
  real.writeAt(0x00ffd5, [0x20]) // map mode byte SmwRom checks
  const rom = new SmwRom(real)
  const file =
    withheld === undefined
      ? real
      : (Object.create(real, {
          readByte: { value: (a: number) => (a === withheld ? null : real.readByte(a)) },
        }) as RomFile)
  return Object.assign(Object.create(rom), {
    rom: file,
    getLevelRawData: () => LEVEL,
    requireVerticalTable: () => [],
  }) as SmwRom
}

describe('buildMapWithGraph and an unreadable Mario start byte', () => {
  it('builds with every byte readable (the control)', () => {
    expect(() => buildMapWithGraph(cart(), 7)).not.toThrow()
  })
  it.each([
    ['DATA_05F000', 0x05f000 + 7],
    ['DATA_05F600', 0x05f600 + 7],
    ['DATA_05D730 (Y low)', 0x05d730],
  ])('refuses when %s cannot be read', (_n, addr) => {
    expect(() => buildMapWithGraph(cart(addr), 7)).toThrow(/Mario start position unavailable/)
  })
})
