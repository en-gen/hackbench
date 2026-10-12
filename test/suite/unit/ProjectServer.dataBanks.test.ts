/**
 * The backend wires the project's data banks to the map models (#755):
 * config file -> WorkingRomRegistry -> ProjectServiceImpl.located -> L1ModelCache.
 * Needs the theia/ workspace installed (project-server.ts imports inversify).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import type { DataBanks } from '../../../src/rom/DataBanks'
import { L1ModelCache } from '../../../theia/extension/src/node/map-screen'

const theiaInstalled = fs.existsSync(
  path.resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)
let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-srv-banks-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe.skipIf(!theiaInstalled)('ProjectServiceImpl map models', () => {
  it('build from the project config, and follow a hand edit on the next request', async () => {
    const romPath = path.join(tmp, 'game.sfc')
    const bytes = Buffer.alloc(0x80000, 0x00)
    bytes[0x7fd5] = 0x20 // LoROM, so SmwRom accepts it and the model build is reached
    fs.writeFileSync(romPath, bytes)
    const romRegistry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
    romRegistry.register(romPath)
    const { manifestPath } = createProject({ romPath, name: 'P', directory: path.join(tmp, 'P') })

    const seen: (DataBanks | undefined)[] = []
    const { ProjectServiceImpl } = await import('../../../theia/extension/src/node/project-server')
    const server = new ProjectServiceImpl() as unknown as Record<string, unknown>
    server.workingRoms = new WorkingRomRegistry(romRegistry)
    server.screens = new L1ModelCache(rom => {
      seen.push(rom.rom.dataBanks)
      return { ok: false, reason: 'spy' }
    })
    const service = server as unknown as InstanceType<typeof ProjectServiceImpl>
    const flags = { green: false, yellow: false, blue: false, red: false }
    const switches = { green: false, yellow: false, blue: false, red: false }

    await service.mapScreen(manifestPath, 0x105, 0, flags, switches as never)
    const file = path.join(path.dirname(manifestPath), 'meta', 'data-banks.json')
    const config = JSON.parse(fs.readFileSync(file, 'utf8'))
    config.banks.objectCode = '$2D'
    fs.writeFileSync(file, JSON.stringify(config))
    await service.mapScreen(manifestPath, 0x105, 0, flags, switches as never)

    expect(seen[0]?.objectCode).toHaveProperty('notFound') // a blank cart: detection recorded why
    expect(seen[1]?.objectCode).toEqual({ bank: 0x2d })
  })
})
