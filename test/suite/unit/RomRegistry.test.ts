/**
 * Pairing a cartridge on this machine to the projects that reference it.
 *
 * A project stores ROM identity and never a path, so it is byte-identical for
 * every contributor. The registry is the per-machine other half: it is the
 * only thing that knows where this user's copy lives, and it is deliberately
 * NOT part of the project directory.
 *
 * The assertion that matters most is that resolving re-verifies. A remembered
 * path that now holds a different cartridge must not resolve, because editing
 * the wrong ROM is silent and the result looks plausible.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { RomRegistry, defaultRegistryPath } from '../../../src/project/RomRegistry'
import { romIdentity } from '../../../src/project/Project'

let tmp: string
let registry: RomRegistry

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hbreg-'))
  registry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/** Synthetic cart. Real bytes are copyrighted and this tests bookkeeping. */
function fakeRom(seed = 31, title = 'SUPER MARIO WORLD  '): Uint8Array {
  const rom = new Uint8Array(0x80000)
  for (let i = 0; i < rom.length; i++) rom[i] = (i * seed) & 0xff
  rom.set(Buffer.from(title.padEnd(21, ' ').slice(0, 21), 'ascii'), 0x7fc0)
  return rom
}

function writeRom(name: string, bytes: Uint8Array): string {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, bytes)
  return p
}

describe('RomRegistry', () => {
  it('resolves a cartridge it was told about', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const id = registry.register(romPath)
    expect(registry.resolve(id.sha256)).toBe(romPath)
  })

  it('resolves under the identity a project stores, header or not', () => {
    // A project records the identity of the CART, so a contributor whose dump
    // carries a copier header must still resolve against the same entry.
    const bare = fakeRom()
    const headered = new Uint8Array(bare.length + 512)
    for (let i = 0; i < 512; i++) headered[i] = (i * 7 + 3) & 0xff
    headered.set(bare, 512)

    const id = registry.register(writeRom('headered.sfc', headered))
    expect(id.sha256).toBe(romIdentity(bare).sha256)
  })

  it('survives a restart, because the point is not remembering in memory', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const id = registry.register(romPath)

    const reopened = new RomRegistry(path.join(tmp, 'rom-registry.json'))
    expect(reopened.resolve(id.sha256)).toBe(romPath)
  })

  it('does not resolve a cartridge it has never seen', () => {
    expect(registry.resolve(romIdentity(fakeRom()).sha256)).toBeNull()
  })

  it('stops resolving once the file is gone', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const id = registry.register(romPath)
    fs.rmSync(romPath)
    // Returning a dead path would send the caller to read a missing file and
    // report it as a corrupt ROM rather than a moved one.
    expect(registry.resolve(id.sha256)).toBeNull()
  })

  /**
   * The assertion this class exists for. Paths are not stable identifiers:
   * the user renames, re-dumps, or drops a different hack at the same name.
   */
  it('refuses a remembered path that now holds a different cartridge', () => {
    const romPath = writeRom('cart.sfc', fakeRom(31))
    const id = registry.register(romPath)

    fs.writeFileSync(romPath, fakeRom(37))

    expect(registry.resolve(id.sha256)).toBeNull()
  })

  it('re-registering a moved cartridge updates the entry rather than duplicating it', () => {
    const first = writeRom('cart.sfc', fakeRom())
    const id = registry.register(first)
    fs.rmSync(first)

    const moved = writeRom('elsewhere.sfc', fakeRom())
    expect(registry.register(moved).sha256).toBe(id.sha256)
    expect(registry.resolve(id.sha256)).toBe(moved)
    expect(registry.list()).toHaveLength(1)
  })

  it('holds several carts at once, since a user has more than one hack', () => {
    const a = registry.register(writeRom('a.sfc', fakeRom(31)))
    const b = registry.register(writeRom('b.sfc', fakeRom(37)))
    expect(a.sha256).not.toBe(b.sha256)
    expect(registry.list()).toHaveLength(2)
  })

  it('forgets on request', () => {
    const id = registry.register(writeRom('cart.sfc', fakeRom()))
    registry.forget(id.sha256)
    expect(registry.resolve(id.sha256)).toBeNull()
  })

  it('starts empty rather than throwing when the file is corrupt', () => {
    const file = path.join(tmp, 'rom-registry.json')
    fs.writeFileSync(file, '{ not json')
    // A damaged registry costs the user one re-pick. Refusing to start the
    // app over it does not.
    const r = new RomRegistry(file)
    expect(r.list()).toEqual([])
    const id = r.register(writeRom('cart.sfc', fakeRom()))
    expect(r.resolve(id.sha256)).not.toBeNull()
  })

  it('keeps no cartridge bytes, only a path and an identity', () => {
    registry.register(writeRom('cart.sfc', fakeRom()))
    const raw = fs.readFileSync(path.join(tmp, 'rom-registry.json'))
    // Bounded by construction: the file holds hashes and paths. A registry
    // that had started caching ROM contents would blow past this instantly.
    expect(raw.length).toBeLessThan(4096)
  })

  it('puts the registry outside any project, in per-user application data', () => {
    const p = defaultRegistryPath()
    expect(path.isAbsolute(p)).toBe(true)
    expect(p.endsWith('.json')).toBe(true)
    expect(p).toMatch(/hackbench/i)
  })
})

/**
 * Proof the verification can fail.
 *
 * A resolve() that only checked existsSync would pass every case above except
 * the swap, so that case is the whole oracle and it gets its own planted
 * defect here.
 */
describe('the oracle can fail', () => {
  it('an existence-only check would resolve the wrong cartridge', () => {
    const romPath = writeRom('cart.sfc', fakeRom(31))
    const id = registry.register(romPath)
    fs.writeFileSync(romPath, fakeRom(37))

    // The naive implementation this guards against.
    const existenceOnly = fs.existsSync(romPath) ? romPath : null
    expect(existenceOnly).toBe(romPath)
    expect(registry.resolve(id.sha256)).toBeNull()
  })
})
