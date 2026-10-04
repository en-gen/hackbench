/**
 * Moving a project's ROM from Project Properties (#527).
 *
 * The dialog browses first and persists only on OK, so the backend has two
 * halves: `checkRom` (read-only) and `relocate` (check, then register). The
 * assertion that matters is that a different cartridge is refused and leaves
 * the registry untouched; retargeting a project is out of scope.
 * Synthetic carts only: CI has no ROM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { createProject } from '../../../src/project/Project'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'

let tmp: string
let registry: RomRegistry
let working: WorkingRomRegistry

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-reloc-'))
  registry = new RomRegistry(path.join(tmp, 'rom-registry.json'))
  working = new WorkingRomRegistry(registry)
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function fakeRom(seed: number): Uint8Array {
  const rom = new Uint8Array(0x80000)
  for (let i = 0; i < rom.length; i++) rom[i] = (i * seed) & 0xff
  rom.set(Buffer.from('SUPER MARIO WORLD  '.padEnd(21, ' '), 'ascii'), 0x7fc0)
  return rom
}

function put(name: string, bytes: Uint8Array): string {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, bytes)
  return p
}

function project(romPath: string): string {
  registry.register(romPath)
  return createProject({ romPath, name: 'P', directory: path.join(tmp, 'proj') }).manifestPath
}

describe('WorkingRomRegistry relocation', () => {
  it('reports the registered path, or null for an unknown hash', () => {
    const rom = put('a.sfc', fakeRom(31))
    const manifest = project(rom)
    const sha = JSON.parse(fs.readFileSync(manifest, 'utf8')).baseRom.sha256
    expect(working.registeredPath(sha)).toBe(rom)
    expect(working.registeredPath('0'.repeat(64))).toBeNull()
  })

  it('checkRom accepts the same cart at another path without registering it', () => {
    const rom = put('a.sfc', fakeRom(31))
    const manifest = project(rom)
    const copy = put('copy.sfc', fakeRom(31))
    expect(working.checkRom(manifest, copy)).toEqual({ status: 'ok' })
    const sha = JSON.parse(fs.readFileSync(manifest, 'utf8')).baseRom.sha256
    expect(working.registeredPath(sha)).toBe(rom)
  })

  it('relocate registers the new path and the working copy follows it', () => {
    const rom = put('a.sfc', fakeRom(31))
    const manifest = project(rom)
    expect(working.get(manifest)).toMatchObject({ status: 'ok', romPath: rom })
    const copy = put('copy.sfc', fakeRom(31))
    expect(working.relocate(manifest, copy)).toEqual({ status: 'ok' })
    expect(working.get(manifest)).toMatchObject({ status: 'ok', romPath: copy })
  })

  it('refuses a different cart naming both hashes, and registers nothing', () => {
    const rom = put('a.sfc', fakeRom(31))
    const manifest = project(rom)
    const other = put('other.sfc', fakeRom(33))
    const r = working.relocate(manifest, other)
    expect(r.status).toBe('mismatch')
    if (r.status !== 'mismatch') return
    expect(r.expected).toBe(JSON.parse(fs.readFileSync(manifest, 'utf8')).baseRom.sha256)
    expect(r.picked).not.toBe(r.expected)
    expect(r.picked).toHaveLength(64)
    expect(registry.list().map(e => e.path)).toEqual([rom])
  })
})
