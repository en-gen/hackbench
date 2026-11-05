/**
 * `buildMapDetails` (theia/extension/src/node/map-details.ts) answers only what the
 * map view still reads from a map's details: its level mode (the unverified-mode
 * warning, #618). The facts strip and the Header panel are gone (#1008), and so are
 * the name, counts, orientation, decoded header and GFX-assignment fields that fed
 * them, with their "unavailable" reasons; these cases pin that they stay gone.
 *
 * `buildMapDetails` is a PURE function taking an `SmwRom`, not a method on
 * `ProjectServiceImpl`, and that is what makes these cases run in CI: the unit
 * job does not install the `theia/` workspace, and `project-server.ts`
 * imports `@theia/core/shared/inversify`, which fails to resolve when that
 * FILE loads -- before any `skipIf` gate on a case inside it ever runs. Same
 * shape as `map16-decode.ts` / `Map16WriteGate.test.ts`, for the same reason.
 *
 * Entirely ROM-free: the fixtures are synthetic RomFiles built in memory,
 * never touching disk.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import * as os from 'os'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { buildMapDetails } from '../../../theia/extension/src/node/map-details'

/** A minimal ROM: LoROM header, one level's L1 pointer, one object. */
function syntheticRom(): SmwRom {
  const buf = Buffer.alloc(0x40000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode
  const rom = new RomFile('synthetic.sfc', buf)
  rom.writeAt(ADDR.ROM_NAME, Buffer.from('HACKBENCH SYNTHETIC  ', 'ascii'))
  rom.writeAt(ADDR.LEVEL_L1_PTR + 0x105 * 3, [0x00, 0x80, 0x06]) // -> SNES $068000
  rom.writeAt(0x068000, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x35, 0x01, 0xff])
  return new SmwRom(rom)
}

/** syntheticRom with slot $105's L1 pointer moved to `ptr`, and `stream`
 *  written there when given. The ROM is $40000 bytes, so it ends at $07FFFF. */
function romWithL1(ptr: number, stream?: number[]): SmwRom {
  const smw = syntheticRom()
  smw.rom.writeAt(ADDR.LEVEL_L1_PTR + 0x105 * 3, [ptr & 0xff, (ptr >> 8) & 0xff, ptr >> 16])
  if (stream) smw.rom.writeAt(ptr, stream)
  return smw
}
const ONE_OBJECT = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x35, 0x01, 0xff]

describe('buildMapDetails - what it answers', () => {
  it('answers the index and the level mode, and nothing the removed strip or Header panel showed (#1008)', () => {
    // toEqual would pass on a stray extra key only if it were undefined, so the
    // key list is pinned too: a field that comes back is a field the view could show.
    const details = buildMapDetails(syntheticRom(), 0x105)
    expect(details).toEqual({ index: 0x105, levelMode: 0 })
    expect(Object.keys(details).sort()).toEqual(['index', 'levelMode'])
  })

  it('answers just the index when the level data is unreadable, with no reason fields', () => {
    for (const ptr of [0x7eb215, 0x07fffc, 0]) {
      const details = buildMapDetails(romWithL1(ptr), 0x105)
      expect(Object.keys(details)).toEqual(['index'])
      expect(details.index).toBe(0x105)
    }
  })

  it('answers the same two keys when the object walk never reaches its terminator', () => {
    // The objects-unavailable reason left with the strip; nothing replaces it here.
    expect(Object.keys(buildMapDetails(romWithL1(0x078000), 0x105)).sort()).toEqual(['index', 'levelMode']) // prettier-ignore
  })
})

describe('buildMapDetails - level data in the last bytes of the ROM', () => {
  it('reads a stream that ends before EOF, as the catalog already calls the slot real', () => {
    const smw = romWithL1(0x07fff0, ONE_OBJECT)
    expect(buildLevelCatalog(smw).entries[0x105]!.isReal).toBe(true)
    expect(buildMapDetails(smw, 0x105).levelMode).toBe(0)
    expect(buildLevelCatalog(smw).entries[0x105]!.parseable).toBe(true)
  })

  it('reads a tail of exactly the five header bytes', () => {
    const details = buildMapDetails(romWithL1(0x07fffb, [0x00, 0x00, 0x00, 0x00, 0x00]), 0x105)
    expect(details.levelMode).toBe(0)
  })

  it('refuses a tail too short to hold the five header bytes', () => {
    expect(buildMapDetails(romWithL1(0x07fffc), 0x105).levelMode).toBeUndefined()
  })
})

describe('buildMapDetails - levelMode', () => {
  it('masks header byte 1 to the 5-bit mode, so $FE reads as 1E (#618)', () => {
    const smw = syntheticRom()
    smw.rom.writeAt(0x068001, [0xfe])
    expect(buildMapDetails(smw, 0x105).levelMode).toBe(0x1e)
  })

  it('is absent when the level data is unavailable', () => {
    expect(buildMapDetails(romWithL1(0x07fffc), 0x105).levelMode).toBeUndefined()
  })
})

/** Whether the Theia workspace is installed - see this file's doc comment. */
const theiaInstalled = existsSync(
  resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)

/**
 * `ProjectServiceImpl` itself cannot be imported where the Theia workspace is
 * absent, so this pins the WIRING (delegation to `buildMapDetails` through a
 * real project + registry) rather than the decision, which the case above
 * already covers everywhere. Gated and dynamically imported so the file still
 * loads, and this case skips visibly, in CI.
 */
describe.skipIf(!theiaInstalled)('ProjectServiceImpl.mapDetails - wiring', () => {
  it('delegates to buildMapDetails through a real project and registry', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const { ProjectServiceImpl } = await import('../../../theia/extension/src/node/project-server')
    const { RomRegistry } = await import('../../../src/project/RomRegistry')
    const { RecentProjects } = await import('../../../src/project/RecentProjects')
    const { WorkingRomRegistry } = await import('../../../src/project/WorkingRomRegistry')

    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'hb-mapdetails-'))
    try {
      const buf = Buffer.alloc(0x40000, 0x00)
      buf[0x7fd5] = 0x20
      const romPath = path.join(tmp, 'synthetic.sfc')
      const rom = new RomFile(romPath, buf)
      rom.writeAt(ADDR.ROM_NAME, Buffer.from('HACKBENCH SYNTHETIC  ', 'ascii'))
      rom.writeAt(ADDR.LEVEL_L1_PTR + 0x105 * 3, [0x00, 0x80, 0x06])
      rom.writeAt(0x068000, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x35, 0x01, 0xff])
      rom.saveAs(romPath)

      const service = new ProjectServiceImpl()
      // Property injection, so the fields are simply assigned. Constructing
      // the class directly keeps this a unit test rather than a container
      // test; temp-file-backed instances so it cannot touch this machine's
      // real application data, which the real constructors default to.
      const s = service as unknown as { workingRoms: unknown; recent: unknown }
      s.workingRoms = new WorkingRomRegistry(new RomRegistry(path.join(tmp, 'registry.json')))
      s.recent = new RecentProjects(path.join(tmp, 'recent.json'))

      const project = await service.createProject({
        romPath,
        name: 'Proj',
        directory: path.join(tmp, 'Proj'),
      })
      const result = await service.mapDetails(project.manifestPath, 0x105)
      if ('status' in result) throw new Error(result.status)
      const details = result

      expect(details).toEqual({ index: 0x105, levelMode: 0 })

      // The map tab's screen goes through the same working copy, and an
      // unbuildable map answers with a reason rather than an empty image.
      const flags = { green: false, yellow: false, blue: false, red: false }
      const switches = { blue: false, silver: false, onOff: false }
      const screen = await service.mapScreen(project.manifestPath, 0x105, 0, flags, switches)
      expect(screen).toMatchObject({ status: 'unavailable' })
      if (screen.status === 'unavailable') expect(screen.detail).toMatch(/VerticalTable/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })

  it('answers rom-not-located, not a throw, when the manifest names a ROM this machine lacks (#786)', async () => {
    const fs = await import('fs')
    const path = await import('path')
    const { ProjectServiceImpl } = await import('../../../theia/extension/src/node/project-server')
    const { RomRegistry } = await import('../../../src/project/RomRegistry')
    const { RecentProjects } = await import('../../../src/project/RecentProjects')
    const { WorkingRomRegistry } = await import('../../../src/project/WorkingRomRegistry')

    const tmp = fs.mkdtempSync(join(os.tmpdir(), 'hb-mapdetails-nl-'))
    try {
      const buf = Buffer.alloc(0x40000, 0x00)
      buf[0x7fd5] = 0x20
      const romPath = path.join(tmp, 'synthetic.sfc')
      const rom = new RomFile(romPath, buf)
      rom.writeAt(ADDR.ROM_NAME, Buffer.from('HACKBENCH SYNTHETIC  ', 'ascii'))
      rom.saveAs(romPath)

      const service = new ProjectServiceImpl()
      const s = service as unknown as { workingRoms: unknown; recent: unknown }
      s.workingRoms = new WorkingRomRegistry(new RomRegistry(path.join(tmp, 'registry.json')))
      s.recent = new RecentProjects(path.join(tmp, 'recent.json'))
      const project = await service.createProject({
        romPath,
        name: 'Proj',
        directory: path.join(tmp, 'Proj'),
      })

      // Another machine: the ROM file is gone and this registry has never seen it.
      fs.rmSync(romPath)
      s.workingRoms = new WorkingRomRegistry(new RomRegistry(path.join(tmp, 'other-registry.json')))
      const result = await service.mapDetails(project.manifestPath, 0x105)
      expect(result).toMatchObject({ status: 'rom-not-located' })
      expect(result).toMatchObject({ baseRom: project.baseRom })
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
