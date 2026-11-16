/**
 * The objects service's own limits path (not the injected one the working-copy
 * test uses): a ROM whose Map16 cannot be read, and a project with no ROM
 * located. Synthetic: a ramp ROM and a project built here, no cartridge.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { rampRom } from '../support/syntheticRegistryRom'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { ObjectsCore } from '../../../theia/extension/src/node/objects-core'

const NOTE = "This ROM's tile table could not be read, so Objects cannot be checked or saved."

let tmp: string
let manifestPath: string
let objects: string
let romRegistry: RomRegistry

const good = {
  version: 1,
  id: 'good0001',
  name: 'Fine',
  tileset: 1,
  edge: [256],
  fill: [257],
}

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-objects-core-'))
  const romPath = path.join(tmp, 'game.sfc')
  fs.writeFileSync(romPath, rampRom())
  romRegistry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
  romRegistry.register(romPath)
  manifestPath = createProject({ romPath, name: 'P', directory: path.join(tmp, 'P') }).manifestPath
  objects = path.join(path.dirname(manifestPath), 'meta', 'objects')
  fs.mkdirSync(objects, { recursive: true })
  fs.writeFileSync(path.join(objects, 'good0001.json'), JSON.stringify(good))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('a ROM whose Map16 cannot be read (the real limits path)', () => {
  it('lists one plain note, no definitions and no per-file noise', () => {
    const core = new ObjectsCore(new WorkingRomRegistry(romRegistry))
    expect(core.list(manifestPath)).toEqual({
      status: 'ok',
      definitions: [],
      skipped: [],
      unavailable: NOTE,
    })
  })

  it('never lets the core reason, with its issue reference, reach the screen', () => {
    const core = new ObjectsCore(new WorkingRomRegistry(romRegistry))
    const seen = JSON.stringify([
      core.list(manifestPath),
      core.save(manifestPath, { name: 'X', tileset: 1, edge: [1], fill: [2] }),
      core.rename(manifestPath, 'good0001', 'Y'),
    ])
    expect(seen).not.toMatch(/github|hackbench#|en-gen|#\d+|issue/i)
  })

  it('refuses a save with that note and writes nothing', () => {
    const core = new ObjectsCore(new WorkingRomRegistry(romRegistry))
    const r = core.save(manifestPath, { name: 'X', tileset: 1, edge: [1], fill: [2] })
    expect(r).toEqual({ status: 'invalid', reason: NOTE })
    expect(fs.readdirSync(objects)).toEqual(['good0001.json'])
  })

  it('refuses a rename with exactly the fixed note as its reason', () => {
    const core = new ObjectsCore(new WorkingRomRegistry(romRegistry))
    expect(core.rename(manifestPath, 'good0001', 'Y')).toEqual({ status: 'invalid', reason: NOTE })
    expect(JSON.parse(fs.readFileSync(path.join(objects, 'good0001.json'), 'utf8')).name).toBe(
      'Fine',
    )
  })

  it('deletes without reading the ROM', () => {
    const core = new ObjectsCore(new WorkingRomRegistry(romRegistry))
    expect(core.delete(manifestPath, 'good0001')).toEqual({ status: 'ok' })
    expect(fs.readdirSync(objects)).toEqual([])
  })
})

describe('a project whose ROM is not located', () => {
  it('says rom-not-located for list, save and rename, and still deletes a file', () => {
    const none = new WorkingRomRegistry(new RomRegistry(path.join(tmp, 'empty-registry.json')))
    const core = new ObjectsCore(none)
    expect(core.list(manifestPath).status).toBe('rom-not-located')
    expect(core.save(manifestPath, { name: 'X', tileset: 1, edge: [1], fill: [2] }).status).toBe(
      'rom-not-located',
    )
    expect(core.rename(manifestPath, 'good0001', 'Y').status).toBe('rom-not-located')
    expect(core.delete(manifestPath, 'good0001')).toEqual({ status: 'ok' })
  })
})

describe('delete resolves the project before it touches a file', () => {
  it('refuses a manifest path that is not a project, and removes nothing', () => {
    const decoy = path.join(tmp, 'Decoy')
    fs.mkdirSync(path.join(decoy, 'meta', 'objects'), { recursive: true })
    fs.writeFileSync(path.join(decoy, 'meta', 'objects', 'victim01.json'), '{}')
    const core = new ObjectsCore(new WorkingRomRegistry(romRegistry))
    expect(() => core.delete(path.join(decoy, 'Nope.hbproj'), 'victim01')).toThrow()
    expect(fs.existsSync(path.join(decoy, 'meta', 'objects', 'victim01.json'))).toBe(true)
  })
})
