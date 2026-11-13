/**
 * Acceptance 5 of #1236, directly: saving, renaming and deleting an Object
 * definition through the objects service's own code path leaves the working
 * copy's bytes and ops/ exactly as they were. Synthetic only: a ramp ROM and
 * a project built here, so CI needs no cartridge.
 *
 * The limits are injected because a ramp ROM has no readable Map16; the
 * working copy is still read through the real WorkingRomRegistry.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as crypto from 'crypto'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { rampRom } from '../support/syntheticRegistryRom'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { ObjectsCore } from '../../../theia/extension/src/node/objects-core'

let tmp: string
let manifestPath: string
let registry: WorkingRomRegistry
let core: ObjectsCore

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-objects-wc-'))
  const romPath = path.join(tmp, 'game.sfc')
  fs.writeFileSync(romPath, rampRom())
  const romRegistry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
  romRegistry.register(romPath)
  manifestPath = createProject({ romPath, name: 'P', directory: path.join(tmp, 'P') }).manifestPath
  registry = new WorkingRomRegistry(romRegistry)
  core = new ObjectsCore(registry, () => ({ tilesetCount: 15, tileCount: 512 }))
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

function workingBytes(): string {
  const r = registry.get(manifestPath)
  if (r.status !== 'ok') throw new Error(`working copy not ok: ${r.status}`)
  return crypto.createHash('sha256').update(r.working.bytes()).digest('hex')
}

/** The base ROM file on disk: the working copy is built from it, so it must not move either. */
function baseRomOnDisk(): string {
  return crypto
    .createHash('sha256')
    .update(fs.readFileSync(path.join(tmp, 'game.sfc')))
    .digest('hex')
}

function opsTree(): string {
  const dir = path.join(path.dirname(manifestPath), 'ops')
  const h = crypto.createHash('sha256')
  const walk = (d: string): void => {
    for (const e of fs
      .readdirSync(d, { withFileTypes: true })
      .sort((a, b) => (a.name < b.name ? -1 : 1))) {
      const p = path.join(d, e.name)
      if (e.isDirectory()) walk(p)
      else h.update(path.relative(dir, p)).update(fs.readFileSync(p))
    }
  }
  if (fs.existsSync(dir)) walk(dir)
  return h.digest('hex')
}

describe('Object definitions never touch the working copy', () => {
  it('leaves its bytes and ops/ identical across save, rename, a second save and delete', () => {
    const bytes = workingBytes()
    const ops = opsTree()
    const rom = baseRomOnDisk()
    const same = (): void => {
      expect(workingBytes()).toBe(bytes)
      expect(opsTree()).toBe(ops)
      expect(baseRomOnDisk()).toBe(rom)
    }

    const saved = core.save(manifestPath, {
      name: 'Ledge',
      tileset: 2,
      edge: [258],
      fill: [259, 300],
    })
    expect(saved.status).toBe('ok')
    if (saved.status !== 'ok') return
    same()

    expect(core.rename(manifestPath, saved.definition.id, 'Long ledge').status).toBe('ok')
    same()

    expect(
      core.save(manifestPath, {
        id: saved.definition.id,
        name: 'Long ledge',
        tileset: 2,
        edge: [258],
        fill: [300],
      }).status,
    ).toBe('ok')
    same()

    const listed = core.list(manifestPath)
    expect(listed.status === 'ok' && listed.definitions.map(d => d.fill)).toEqual([[300]])

    expect(core.delete(manifestPath, saved.definition.id)).toEqual({ status: 'ok' })
    same()
    // The steps did real work: the file came and went in meta/, not in the ROM.
    expect(
      fs.existsSync(
        path.join(path.dirname(manifestPath), 'meta', 'objects', `${saved.definition.id}.json`),
      ),
    ).toBe(false)
  })

  it('would notice a write to the working copy: the comparison can fail', () => {
    const before = workingBytes()
    const r = registry.get(manifestPath)
    if (r.status !== 'ok') throw new Error('not ok')
    r.working.bytes()[0x100] ^= 0xff
    expect(workingBytes()).not.toBe(before)
  })

  it('would notice a file appearing under ops/: the ops fingerprint can change', () => {
    const before = opsTree()
    const ops = path.join(path.dirname(manifestPath), 'ops')
    fs.mkdirSync(ops, { recursive: true })
    fs.writeFileSync(path.join(ops, '0001-planted.json'), '{}')
    expect(opsTree()).not.toBe(before)
  })

  it('would notice the base ROM file changing', () => {
    const before = baseRomOnDisk()
    const rom = path.join(tmp, 'game.sfc')
    const bytes = fs.readFileSync(rom)
    bytes[0x200] ^= 0xff
    fs.writeFileSync(rom, bytes)
    expect(baseRomOnDisk()).not.toBe(before)
  })
})
