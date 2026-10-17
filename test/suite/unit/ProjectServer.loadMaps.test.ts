/**
 * ProjectServiceImpl.loadMaps reads the project's map aliases for explorer
 * search (#336, D79 call 1). Synthetic blank LoROM, no corpus: CI has no ROM.
 * Needs the theia/ workspace installed (project-server.ts imports inversify).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'

const theiaInstalled = fs.existsSync(
  path.resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)
let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-srv-aliases-'))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

async function setup(aliasesJson: string | undefined) {
  const romPath = path.join(tmp, 'game.sfc')
  const bytes = Buffer.alloc(0x80000, 0x00)
  bytes[0x7fd5] = 0x20 // LoROM, so SmwRom accepts it
  fs.writeFileSync(romPath, bytes)
  const romRegistry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
  romRegistry.register(romPath)
  const { manifestPath } = createProject({ romPath, name: 'P', directory: path.join(tmp, 'P') })
  if (aliasesJson !== undefined) {
    const meta = path.join(path.dirname(manifestPath), 'meta')
    fs.mkdirSync(meta, { recursive: true })
    fs.writeFileSync(path.join(meta, 'aliases.json'), aliasesJson)
  }
  const { ProjectServiceImpl } = await import('../../../theia/extension/src/node/project-server')
  const server = new ProjectServiceImpl() as unknown as Record<string, unknown>
  server.workingRoms = new WorkingRomRegistry(romRegistry)
  const service = server as unknown as InstanceType<typeof ProjectServiceImpl>
  return service.loadMaps(manifestPath)
}

describe.skipIf(!theiaInstalled)('ProjectServiceImpl.loadMaps map aliases', () => {
  it('puts a map alias from aliases.json in mapAliases', async () => {
    const r = await setup(JSON.stringify({ map: { '105': 'Castle Rush' } }))
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.mapAliases).toEqual({ '105': 'Castle Rush' })
    expect(r.aliasesError).toBeUndefined()
  })

  it('a bad aliases.json keeps the maps, gives no aliases and says why', async () => {
    const r = await setup('[1, 2]')
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.mapAliases).toEqual({})
    expect(r.aliasesError).toBe('is not an object of namespaces')
  })

  it('an unparseable aliases.json reports the same way', async () => {
    const r = await setup('{ not json')
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.mapAliases).toEqual({})
    expect(r.aliasesError).toBeTruthy()
  })

  it('a missing aliases.json is no error', async () => {
    const r = await setup(undefined)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.mapAliases).toEqual({})
    expect(r.aliasesError).toBeUndefined()
  })
})
