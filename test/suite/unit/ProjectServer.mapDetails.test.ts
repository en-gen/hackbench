/**
 * `buildMapDetails` (theia/extension/src/node/map-details.ts) degrades
 * orientation the same way it degrades sprites: a ROM whose VerticalTable
 * read is unavailable still returns header, screens and object count (none
 * of them read isVertical), with only isVertical itself absent and carrying
 * the gate's reason.
 *
 * `buildMapDetails` is a PURE function taking an `SmwRom`, not a method on
 * `ProjectServiceImpl`, and that is what makes this case run in CI: the unit
 * job does not install the `theia/` workspace, and `project-server.ts`
 * imports `@theia/core/shared/inversify`, which fails to resolve when that
 * FILE loads -- before any `skipIf` gate on a case inside it ever runs. Same
 * shape as `map16-decode.ts` / `Map16WriteGate.test.ts`, for the same reason.
 *
 * Entirely ROM-free: the fixture is a synthetic RomFile built in memory, with
 * no VerticalTable or sprite-pointer pattern planted anywhere, so both gates
 * are naturally unavailable. Never touches disk.
 */
import { describe, it, expect } from 'vitest'
import { existsSync } from 'fs'
import { resolve, join } from 'path'
import * as os from 'os'
import { RomFile } from '../../../src/rom/RomFile'
import { SmwRom, ADDR } from '../../../src/rom/SmwRom'
import { deriveOverworldEntrances } from '../../../src/rom/OverworldEntrances'
import { OW_ADDR } from '../../../src/rom/OverworldLoader'
import { buildMapDetails } from '../../../theia/extension/src/node/map-details'
import { plantStockSubmapCode, SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'

/** A minimal ROM: LoROM header, one level's L1 pointer, one object, no
 *  VerticalTable or sprite-pointer pattern anywhere. */
function syntheticRom(): SmwRom {
  const buf = Buffer.alloc(0x40000, 0x00)
  buf[0x7fd5] = 0x20 // LoROM map mode
  const rom = new RomFile('synthetic.sfc', buf)
  rom.writeAt(ADDR.ROM_NAME, Buffer.from('HACKBENCH SYNTHETIC  ', 'ascii'))
  rom.writeAt(ADDR.LEVEL_L1_PTR + 0x105 * 3, [0x00, 0x80, 0x06]) // -> SNES $068000
  rom.writeAt(0x068000, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x35, 0x01, 0xff])
  return new SmwRom(rom)
}

describe('buildMapDetails - orientation unavailable', () => {
  it('still returns header, screens and object count; only isVertical goes absent', () => {
    const details = buildMapDetails(syntheticRom(), 0x105)

    expect(details.isVertical).toBeUndefined()
    expect(details.orientationUnavailable).toMatch(/VerticalTable/)
    expect(details.headerBytes).toEqual([0, 0, 0, 0, 0])
    expect(details.screens).toBe(1)
    expect(details.objectCount).toBe(1)
  })
})

describe('buildMapDetails - name unavailable', () => {
  it('carries the reason instead of a name when the overworld gate is not stock', () => {
    // syntheticRom plants no submap-gate code, so the walk name resolution
    // depends on is unreadable, the same way it is for a real edited ROM.
    const details = buildMapDetails(syntheticRom(), 0x105)

    expect(details.name).toBeNull()
    expect(details.nameUnavailable).toMatch(/rebuilt by another editor/)
  })
})

/** Negative control for the case above: a ROM whose overworld gate IS stock
 *  and whose walk reaches slot $001, with a name planted there. Without
 *  this, a version of `buildMapDetails` that always nulls the name, or
 *  always reports a reason, would still pass every other test in this file. */
function namedStockRom(): SmwRom {
  const buf = Buffer.alloc(0x80000, 0x00)
  buf[0x7fd5] = 0x20
  const rom = new RomFile('stock.sfc', buf)
  plantStockSubmapCode(rom)
  rom.writeAt(OW_ADDR.L1_TILEDATA, [0x6e]) // one main-map launch tile -> translevel 1, slot $001
  rom.writeAt(ADDR.LEVEL_L1_PTR + 0x001 * 3, [0x00, 0x80, 0x06]) // -> SNES $068000
  rom.writeAt(0x068000, [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x35, 0x01, 0xff])
  // Name table entry for translevel 1: prefix table 0 -> "AB", type/suffix skipped.
  rom.writeAt(0x049ac5, [0x00, 0x81]) // 'A' then 'B', terminated
  rom.writeAt(0x049ac5 + 0x10, [0x9f, 0x80]) // type skip-marker
  rom.writeAt(0x049ac5 + 0x20, [0x9a]) // suffix, empty
  rom.writeAt(0x049c91, [0x00, 0x00]) // prefix table 0 -> offset $00
  rom.writeAt(0x049ccf, [0x10, 0x00]) // type table 0 -> offset $10
  rom.writeAt(0x049ced, [0x20, 0x00]) // suffix table 0 -> offset $20
  rom.writeAt(0x04a0fc + 1 * 2, [0x00, 0x80]) // LevelNames[1], byte1=$80 selects prefix 0
  return new SmwRom(rom)
}

describe('buildMapDetails - stock name present (negative control)', () => {
  it('returns the real name and no nameUnavailable when the overworld gate is stock', () => {
    const rom = namedStockRom()
    const entrances = deriveOverworldEntrances(rom, undefined, SYNTHETIC_FINGERPRINTS)
    const details = buildMapDetails(rom, 0x001, entrances)

    expect(details.name).toBe('AB')
    expect(details.nameUnavailable).toBeUndefined()
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
      const s = service as unknown as { registry: unknown; recent: unknown }
      s.registry = new RomRegistry(path.join(tmp, 'registry.json'))
      s.recent = new RecentProjects(path.join(tmp, 'recent.json'))

      const project = await service.createProject({
        romPath,
        name: 'Proj',
        directory: path.join(tmp, 'Proj'),
      })
      const details = await service.mapDetails(project.manifestPath, 0x105)

      expect(details.isVertical).toBeUndefined()
      expect(details.orientationUnavailable).toMatch(/VerticalTable/)
      expect(details.objectCount).toBe(1)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
