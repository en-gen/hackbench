/**
 * #945: the model build hands the camera readers a defined entrance record for a map the exit graph
 * never reached (so the chooser notes "no route"), and the graph's own record when it has one. A
 * blank cart with the readers spied; the graph is passed in, no ROM bytes.
 */
import { describe, it, expect, vi } from 'vitest'
import { RomFile } from '../../../../src/rom/RomFile'
import { SmwRom, type MapEntrances } from '../../../../src/rom/SmwRom'
import { buildMapWithGraph } from '../../../../src/rom/model/MapBuilder'
import * as L3LoaderMod from '../../../../src/rom/L3Loader'
import * as L2LoaderMod from '../../../../src/rom/L2Loader'

vi.mock('../../../../src/rom/ObjectExpander', async orig => ({ ...(await orig<object>()), expandMap: () => [] })) // prettier-ignore
vi.mock('../../../../src/rom/model/tiles/TileFactory', async orig => ({ ...(await orig<object>()), buildTiles: () => new Map() })) // prettier-ignore
vi.mock('../../../../src/rom/model/L2Factory', async orig => ({ ...(await orig<object>()), buildBgTiles: () => new Map() })) // prettier-ignore
vi.mock('../../../../src/rom/L3Loader', async orig => {
  const real = await orig<typeof L3LoaderMod>()
  return { ...real, readInitialLayer1YPos: vi.fn(real.readInitialLayer1YPos) }
})
vi.mock('../../../../src/rom/L2Loader', async orig => {
  const real = await orig<typeof L2LoaderMod>()
  return { ...real, readInitialLayer2YPos: vi.fn(real.readInitialLayer2YPos) }
})

const LEVEL = Buffer.from([0x00, 0x00, 0x00, 0x00, 0x00, 0xff])

function cart(): SmwRom {
  const real = RomFile.fromBytes('blank.sfc', Buffer.alloc(0x100000))
  real.writeAt(0x00ffd5, [0x20])
  return Object.assign(Object.create(new SmwRom(real)), {
    rom: real,
    getLevelRawData: () => LEVEL,
    requireVerticalTable: () => [],
  }) as SmwRom
}

const viaArg = (spy: unknown) => (spy as ReturnType<typeof vi.fn>).mock.calls.at(-1)?.[3]

describe('buildMapWithGraph hands the camera readers the map entrances (#945)', () => {
  it('a graph that lacks the map gives a defined record with no route, which the chooser notes', () => {
    buildMapWithGraph(cart(), 7, { entrances: new Map() })
    for (const spy of [L3LoaderMod.readInitialLayer1YPos, L2LoaderMod.readInitialLayer2YPos]) {
      const via = viaArg(spy) as MapEntrances | undefined
      expect(via).toBeDefined()
      expect(L3LoaderMod.chooseEntranceNoted(via).note).toMatch(/no route/i)
    }
  })
  it('the graph record itself is passed when the map has one; no graph passes undefined', () => {
    const record: MapEntrances = {
      overworld: false,
      primary: false,
      secondary: [0x30],
      route: 0x30,
    }
    buildMapWithGraph(cart(), 7, { entrances: new Map([[7, record]]) })
    expect(viaArg(L3LoaderMod.readInitialLayer1YPos)).toBe(record)
    buildMapWithGraph(cart(), 7, { entrances: undefined })
    expect(viaArg(L3LoaderMod.readInitialLayer1YPos)).toBeUndefined()
  })
})
