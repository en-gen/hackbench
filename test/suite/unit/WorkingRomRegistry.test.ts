/**
 * WorkingRomRegistry: one WorkingRom per open project, shared by every
 * backend service. See docs/glossary.md, "Working copy".
 *
 * `setColor` always records one committed `edit` layer, validated against
 * the value currently at that address.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { loadLayers } from '../../../src/project/OpsStore'
import { loromToOffset } from '../../../src/rom/addressing'

let tmp: string
let romRegistry: RomRegistry
let working: WorkingRomRegistry

const MARIO_RED_ADDR = 0x00b2ce

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-wrreg-'))
  romRegistry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
  working = new WorkingRomRegistry(romRegistry)
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fakeRom(): Uint8Array {
  const rom = new Uint8Array(0x80000)
  for (let i = 0; i < rom.length; i++) rom[i] = (i * 31) & 0xff
  rom.set(Buffer.from('SUPER MARIO WORLD  ', 'ascii'), 0x7fc0)
  const offset = loromToOffset(MARIO_RED_ADDR, rom.length, false) as number
  rom[offset] = 0x1f
  rom[offset + 1] = 0x39 // $391F
  return rom
}

function makeProject(): { manifestPath: string } {
  const romPath = path.join(tmp, 'game.sfc')
  fs.writeFileSync(romPath, fakeRom())
  romRegistry.register(romPath)
  const p = createProject({ romPath, name: 'MyHack', directory: path.join(tmp, 'MyHack') })
  return { manifestPath: p.manifestPath }
}

describe('WorkingRomRegistry', () => {
  it('rom-not-located when the cartridge was never registered', () => {
    const romPath = path.join(tmp, 'unregistered.sfc')
    fs.writeFileSync(romPath, fakeRom())
    const p = createProject({ romPath, name: 'Ghost', directory: path.join(tmp, 'Ghost') })
    // A fresh registry instance that never saw this ROM registered.
    const isolated = new WorkingRomRegistry(new RomRegistry(path.join(tmp, 'other-registry.json')))
    const r = isolated.get(p.manifestPath)
    expect(r.status).toBe('rom-not-located')
  })

  it('setColor records one persisted edit layer and updates bytes()', () => {
    const { manifestPath } = makeProject()
    const r1 = working.setColor(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$391F',
      newHex: '$03E0',
    })
    expect(r1.status).toBe('ok')
    if (r1.status !== 'ok') throw new Error('unreachable')

    const offset = loromToOffset(MARIO_RED_ADDR, r1.working.baseBytes().length, false) as number
    const bytes = r1.working.bytes()
    expect(bytes[offset] | (bytes[offset + 1] << 8)).toBe(0x03e0)

    const persisted = loadLayers(r1.project.directory)
    expect(persisted).toHaveLength(1)
    expect(persisted[0].ops[0]).toEqual({ address: '$00B2CE', old: '$391F', new: '$03E0' })
  })

  it('each call against the newly-committed value records its own layer, in order', () => {
    const { manifestPath } = makeProject()
    working.setColor(manifestPath, { romAddr: MARIO_RED_ADDR, oldHex: '$391F', newHex: '$1000' })
    const r2 = working.setColor(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$1000', // the value the FIRST call just committed, not the original
      newHex: '$2000',
    })
    expect(r2.status).toBe('ok')
    if (r2.status !== 'ok') throw new Error('unreachable')

    expect(r2.working.stack).toHaveLength(2)
    expect(loadLayers(r2.project.directory)).toHaveLength(2)

    const offset = loromToOffset(MARIO_RED_ADDR, r2.working.baseBytes().length, false) as number
    const bytes = r2.working.bytes()
    expect(bytes[offset] | (bytes[offset + 1] << 8)).toBe(0x2000)
  })

  it('setColor refuses a stale oldHex instead of silently overwriting', () => {
    const { manifestPath } = makeProject()
    working.setColor(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$391F',
      newHex: '$03E0',
    })
    const stale = working.setColor(manifestPath, {
      romAddr: MARIO_RED_ADDR,
      oldHex: '$391F', // no longer true: the first edit already changed it
      newHex: '$7C00',
    })
    expect(stale.status).toBe('stale')
    // The rejected edit never persisted a second layer.
    const r = working.get(manifestPath)
    if (r.status !== 'ok') throw new Error('unreachable')
    expect(loadLayers(r.project.directory)).toHaveLength(1)
  })

  it('the same manifest path returns the same in-memory WorkingRom across calls', () => {
    const { manifestPath } = makeProject()
    const a = working.get(manifestPath)
    const b = working.get(manifestPath)
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('unreachable')
    expect(a.working).toBe(b.working)
  })
})
