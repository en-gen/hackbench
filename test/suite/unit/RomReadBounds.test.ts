/**
 * Bounded ROM reads and manifest name/shape validation (#466, #240).
 * Synthetic only: temp dirs, no ROM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { readRomBounded, MAX_ROM_FILE_BYTES } from '../../../src/project/BoundedRead'
import { createProject, openProject } from '../../../src/project/Project'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { exportPatch } from '../../../src/project/ExportPatch'
import { WorkingRom } from '../../../src/project/WorkingRom'

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-bounds-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

function smallRom(): string {
  const p = path.join(tmp, 'a.sfc')
  fs.writeFileSync(p, new Uint8Array(0x80000))
  return p
}

function sparseFile(size: number): string {
  const p = path.join(tmp, 'big.sfc')
  const fd = fs.openSync(p, 'w')
  fs.ftruncateSync(fd, size)
  fs.closeSync(fd)
  return p
}

describe('readRomBounded', () => {
  it('reads a regular file', () => {
    expect(readRomBounded(smallRom()).length).toBe(0x80000)
  })
  it('refuses a directory', () => {
    expect(() => readRomBounded(tmp)).toThrow(/[Nn]ot a regular file/)
  })
  it('refuses an over-limit file without reading it', () => {
    expect(() => readRomBounded(sparseFile(MAX_ROM_FILE_BYTES + 1))).toThrow(/too large/)
  })
  it('accepts a file exactly at the limit', () => {
    expect(readRomBounded(sparseFile(MAX_ROM_FILE_BYTES)).length).toBe(MAX_ROM_FILE_BYTES)
  })
})

describe('every caller-supplied ROM read is bounded', () => {
  it('createProject refuses a directory and an oversize file', () => {
    expect(() =>
      createProject({ romPath: tmp, name: 'p', directory: path.join(tmp, 'd1') }),
    ).toThrow(/[Nn]ot a regular file/)
    expect(() =>
      createProject({
        romPath: sparseFile(MAX_ROM_FILE_BYTES + 1),
        name: 'p',
        directory: path.join(tmp, 'd2'),
      }),
    ).toThrow(/too large/)
  })
  it('RomRegistry.register refuses a directory and an oversize file', () => {
    const reg = new RomRegistry(path.join(tmp, 'reg.json'))
    expect(() => reg.register(tmp)).toThrow(/[Nn]ot a regular file/)
    expect(() => reg.register(sparseFile(MAX_ROM_FILE_BYTES + 1))).toThrow(/too large/)
  })
})

describe('project name validation', () => {
  const bad = [
    '../x',
    'a/b',
    'a\b',
    'CON',
    'con.txt',
    'NUL',
    'COM1',
    'x.',
    'x ',
    '.',
    '..',
    'a:b',
    'a*b',
  ]
  for (const name of bad) {
    it(`createProject refuses ${JSON.stringify(name)} and leaves no directory behind`, () => {
      const directory = path.join(tmp, 'proj')
      expect(() => createProject({ romPath: smallRom(), name, directory })).toThrow(/name/i)
      expect(fs.existsSync(directory)).toBe(false)
    })
  }

  function manifestWith(patch: Record<string, unknown>): string {
    const p = createProject({ romPath: smallRom(), name: 'ok', directory: path.join(tmp, 'g') })
    const raw = JSON.parse(fs.readFileSync(p.manifestPath, 'utf8'))
    fs.writeFileSync(p.manifestPath, JSON.stringify({ ...raw, ...patch }))
    return p.manifestPath
  }
  for (const name of ['../../x', 'a/b', 'CON', 'x.']) {
    it(`openProject refuses a manifest named ${JSON.stringify(name)}`, () => {
      expect(() => openProject(manifestWith({ name }))).toThrow(/name/i)
    })
  }

  it('createProject does not replace an existing manifest', () => {
    const directory = path.join(tmp, 'w')
    fs.mkdirSync(directory)
    // Empty dir passes the occupancy check; plant the manifest after it via a
    // race-free proxy: the exclusive flag must refuse a pre-existing file.
    createProject({ romPath: smallRom(), name: 'ok', directory })
    fs.rmSync(path.join(directory, 'levels'), { recursive: true })
    fs.rmSync(path.join(directory, 'snapshots'), { recursive: true })
    expect(() => createProject({ romPath: smallRom(), name: 'ok', directory })).toThrow()
  })
})

describe('manifest shape', () => {
  it('a manifest without baseRom is unreadable through the registry, not a TypeError', () => {
    const p = createProject({ romPath: smallRom(), name: 'ok', directory: path.join(tmp, 's') })
    const raw = JSON.parse(fs.readFileSync(p.manifestPath, 'utf8'))
    delete raw.baseRom
    fs.writeFileSync(p.manifestPath, JSON.stringify(raw))
    expect(() => openProject(p.manifestPath)).toThrow(/baseRom/)
    const r = new WorkingRomRegistry(new RomRegistry(path.join(tmp, 'reg.json'))).get(
      p.manifestPath,
    )
    expect(r.status).toBe('unreadable')
  })
  it('refuses a malformed baseRom', () => {
    const p = createProject({ romPath: smallRom(), name: 'ok', directory: path.join(tmp, 's2') })
    const raw = JSON.parse(fs.readFileSync(p.manifestPath, 'utf8'))
    raw.baseRom = { sha256: 5 }
    fs.writeFileSync(p.manifestPath, JSON.stringify(raw))
    expect(() => openProject(p.manifestPath)).toThrow(/baseRom/)
  })
})

describe('exportPatch guards', () => {
  const working = () => new WorkingRom(new Uint8Array(0x80000), false)
  it('refuses a format that is not bps or ips', () => {
    expect(() => exportPatch(tmp, 'x', working(), '../../evil' as never)).toThrow(/format/)
  })
  it('refuses a name that would leave export/', () => {
    expect(() => exportPatch(tmp, '../../x', working(), 'ips')).toThrow(/name/i)
    expect(fs.existsSync(path.join(tmp, '..', '..', 'x.ips'))).toBe(false)
  })
})
