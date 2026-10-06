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
import { buildLevelCatalog } from '../../../src/rom/LevelCatalog'
import { OW_ADDR } from '../../../src/rom/OverworldLoader'
import { buildMapDetails } from '../../../theia/extension/src/node/map-details'
import { plantStockSubmapCode, SYNTHETIC_FINGERPRINTS } from '../support/syntheticRom'
import { PREPARE_GFX, jsl, plantGfxHook, plantGfxReadPath } from '../support/syntheticGfxCart'

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

describe('buildMapDetails - GFX assignment mark', () => {
  it('marks a map on a ROM whose level GFX call goes through the hook, and not a stock one', () => {
    const smw = syntheticRom()
    plantGfxReadPath(smw.rom)
    expect(buildMapDetails(smw, 0x105).gfxAssignmentNote).toBeUndefined()
    plantGfxHook(smw.rom, 0x019000, PREPARE_GFX, 'direct')
    smw.rom.writeAt(0x00aa6b, jsl(0x019000))
    const details = buildMapDetails(smw, 0x105)
    expect(details.gfxAssignmentNote).toMatch(/FG\/BG and sprite GFX files/)
    expect(details.headerBytes).toEqual([0, 0, 0, 0, 0])
  })

  it("carries why the GFX upload filter can't be verified", () => {
    const smw = syntheticRom()
    plantGfxReadPath(smw.rom)
    smw.rom.writeAt(0x00aa49, [0x20, 0x00, 0x90]) // JSR UploadGFXFile, FG/BG loop
    expect(buildMapDetails(smw, 0x105).gfxAssignmentNote).toMatch(/drawn as stored, unverified/)
  })
})

/** syntheticRom with slot $105's L1 pointer moved to `ptr`, and `stream`
 *  written there when given. The ROM is $40000 bytes, so it ends at $07FFFF. */
function romWithL1(ptr: number, stream?: number[]): SmwRom {
  const smw = syntheticRom()
  smw.rom.writeAt(ADDR.LEVEL_L1_PTR + 0x105 * 3, [ptr & 0xff, (ptr >> 8) & 0xff, ptr >> 16])
  if (stream) smw.rom.writeAt(ptr, stream)
  return smw
}
const ONE_OBJECT = [0x00, 0x00, 0x00, 0x00, 0x00, 0x00, 0x35, 0x01, 0xff]

describe('buildMapDetails - level data in the last bytes of the ROM', () => {
  it('reads a stream that ends before EOF, as the catalog already calls the slot real', () => {
    const smw = romWithL1(0x07fff0, ONE_OBJECT)
    expect(buildLevelCatalog(smw).entries[0x105]!.isReal).toBe(true)

    const details = buildMapDetails(smw, 0x105)
    expect(details.levelDataUnavailable).toBeUndefined()
    expect(details.objectCount).toBe(1)
    expect(buildLevelCatalog(smw).entries[0x105]!.parseable).toBe(true)
  })

  it('reads a tail longer than $100 bytes whose $FF is the last byte of the ROM', () => {
    const objects = Array.from({ length: 90 }, () => [0x00, 0x35, 0x01]).flat()
    const stream = [0x00, 0x00, 0x00, 0x00, 0x00, ...objects, 0xff] // 276 bytes
    const details = buildMapDetails(romWithL1(0x080000 - stream.length, stream), 0x105)
    expect(details.objectCount).toBe(90)
  })

  it('reads a tail of exactly the five header bytes, with no object count', () => {
    const details = buildMapDetails(romWithL1(0x07fffb, [0x00, 0x00, 0x00, 0x00, 0x00]), 0x105)
    expect(details.levelDataUnavailable).toBeUndefined()
    expect(details.headerBytes).toEqual([0, 0, 0, 0, 0])
    expect(details.objectCount).toBeUndefined()
    expect(details.objectsUnavailable).toMatch(/\$FF terminator/)
  })

  it('refuses a tail too short to hold the five header bytes', () => {
    const details = buildMapDetails(romWithL1(0x07fffc), 0x105)
    expect(details.levelDataUnavailable).toMatch(/\$07FFFC does not address/)
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

describe('buildMapDetails - level data unavailable', () => {
  it('returns the reason instead of throwing when the pointer is outside the ROM', () => {
    const details = buildMapDetails(romWithL1(0x7eb215), 0x105)
    expect(details.levelDataUnavailable).toMatch(/\$7EB215 does not address this ROM's data/)
    expect(details.index).toBe(0x105)
    expect(details.headerBytes).toBeUndefined()
    expect(details.header).toBeUndefined()
  })

  it('keeps the name reason when the level data is unavailable', () => {
    const details = buildMapDetails(romWithL1(0x7eb215), 0x105)
    expect(details.name).toBeNull()
    expect(details.nameUnavailable).toMatch(/rebuilt by another editor/)
  })

  it('says so when the slot has no pointer at all', () => {
    expect(buildMapDetails(romWithL1(0), 0x105).levelDataUnavailable).toMatch(/no Layer 1 pointer/)
  })
})

describe('buildMapDetails - objects unavailable', () => {
  it('withholds the object count when the walk never reaches $FF', () => {
    // Zero bytes decode as 4-byte screen exits, so the walk runs off the read.
    const details = buildMapDetails(romWithL1(0x078000), 0x105)
    expect(details.objectCount).toBeUndefined()
    expect(details.objectsUnavailable).toMatch(/did not reach its \$FF terminator/)
    expect(details.screens).toBe(1)
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

  it('keeps the name when the level data is unavailable', () => {
    const rom = namedStockRom()
    rom.rom.writeAt(ADDR.LEVEL_L1_PTR + 0x001 * 3, [0x00, 0x00, 0x7e]) // -> WRAM
    const entrances = deriveOverworldEntrances(rom, undefined, SYNTHETIC_FINGERPRINTS)
    const details = buildMapDetails(rom, 0x001, entrances)

    expect(details.levelDataUnavailable).toMatch(/\$7E0000/)
    expect(details.name).toBe('AB')
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
      const details = await service.mapDetails(project.manifestPath, 0x105)

      expect(details.isVertical).toBeUndefined()
      expect(details.orientationUnavailable).toMatch(/VerticalTable/)
      expect(details.objectCount).toBe(1)

      // The map tab's screen goes through the same working copy, and an
      // unbuildable map answers with a reason rather than an empty image.
      const flags = { green: false, yellow: false, blue: false, red: false }
      const switches = { blue: false, silver: false, onOff: false }
      const screen = await service.mapScreen(project.manifestPath, 0x105, 0, flags, switches)
      expect(screen).toMatchObject({ status: 'unavailable' })
      if (screen.status === 'unavailable') expect(screen.reason).toMatch(/VerticalTable/)
    } finally {
      fs.rmSync(tmp, { recursive: true, force: true })
    }
  })
})
