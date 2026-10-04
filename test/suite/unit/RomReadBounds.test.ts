/**
 * Bounded reads and manifest name/shape validation (#466, #240).
 * Synthetic only: temp dirs, no ROM.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import { execFileSync, spawnSync } from 'child_process'
import { buildSync } from 'esbuild'
import {
  readRomBounded,
  readManifestBounded,
  MAX_ROM_FILE_BYTES,
  MAX_MANIFEST_BYTES,
} from '../../../src/project/BoundedRead'
import { createProject, openProject, updateProject } from '../../../src/project/Project'
import { RomRegistry } from '../../../src/project/RomRegistry'
import { WorkingRomRegistry } from '../../../src/project/WorkingRomRegistry'
import { exportPatch } from '../../../src/project/ExportPatch'
import { WorkingRom } from '../../../src/project/WorkingRom'

// Only so the wx test can hide a planted manifest from the occupancy check.
vi.mock('fs', async importOriginal => {
  const actual = await importOriginal<typeof import('fs')>()
  return {
    ...actual,
    default: actual,
    readdirSync: vi.fn(actual.readdirSync),
    readFileSync: vi.fn(actual.readFileSync),
    openSync: vi.fn(actual.openSync),
  }
})

const theiaInstalled = fs.existsSync(
  path.resolve(__dirname, '../../../theia/node_modules/@theia/core/package.json'),
)

let tmp: string
beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-bounds-'))
})
afterEach(() => {
  vi.restoreAllMocks()
  fs.rmSync(tmp, { recursive: true, force: true })
})

function smallRom(): string {
  const p = path.join(tmp, 'a.sfc')
  fs.writeFileSync(p, new Uint8Array(0x80000))
  return p
}

function sparseFile(size: number): string {
  const p = path.join(tmp, `big${size}.sfc`)
  const fd = fs.openSync(p, 'w')
  fs.ftruncateSync(fd, size)
  fs.closeSync(fd)
  return p
}

const NOT_FILE = /not a regular file/i

describe('readRomBounded', () => {
  it('reads a regular file', () => {
    expect(readRomBounded(smallRom()).length).toBe(0x80000)
  })
  it('refuses a directory', () => {
    expect(() => readRomBounded(tmp)).toThrow(NOT_FILE)
  })
  it('refuses a file one byte over the limit without reading it', () => {
    expect(() => readRomBounded(sparseFile(MAX_ROM_FILE_BYTES + 1))).toThrow(/too large/)
  })
  it('limit is 8 MiB plus the 512-byte header, and a file exactly there is read', () => {
    expect(MAX_ROM_FILE_BYTES).toBe(8 * 1024 * 1024 + 512)
    expect(readRomBounded(sparseFile(8 * 1024 * 1024 + 512)).length).toBe(8 * 1024 * 1024 + 512)
  })
  it('manifest cap is 1 MiB: a 2 MiB manifest is refused', () => {
    expect(MAX_MANIFEST_BYTES).toBe(1024 * 1024)
    const p = path.join(tmp, 'm2.hbproj')
    fs.writeFileSync(p, Buffer.alloc(2 * 1024 * 1024))
    expect(() => readManifestBounded(p)).toThrow(/too large/)
  })
  it('manifest reads are capped far lower', () => {
    const p = path.join(tmp, 'm.hbproj')
    fs.writeFileSync(p, Buffer.alloc(MAX_MANIFEST_BYTES + 1))
    expect(() => readManifestBounded(p)).toThrow(/too large/)
  })
})

describe('every caller-supplied ROM read is bounded', () => {
  it('createProject refuses a directory and an oversize file', () => {
    expect(() =>
      createProject({ romPath: tmp, name: 'p', directory: path.join(tmp, 'd1') }),
    ).toThrow(NOT_FILE)
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
    expect(() => reg.register(tmp)).toThrow(NOT_FILE)
    expect(() => reg.register(sparseFile(MAX_ROM_FILE_BYTES + 1))).toThrow(/too large/)
  })
  it('RomRegistry.resolve reads the ROM through the bounded reader, not readFileSync', () => {
    const reg = new RomRegistry(path.join(tmp, 'reg.json'))
    const rom = smallRom()
    const id = reg.register(rom)
    vi.mocked(fs.readFileSync).mockClear()
    expect(reg.resolve(id.sha256)).toBe(rom)
    expect(vi.mocked(fs.readFileSync).mock.calls.map(c => String(c[0]))).not.toContain(rom)
  })
  it('RomRegistry.resolve returns null for a registered path that became a directory or oversize', () => {
    const reg = new RomRegistry(path.join(tmp, 'reg.json'))
    const rom = smallRom()
    const id = reg.register(rom)
    fs.rmSync(rom)
    fs.mkdirSync(rom)
    expect(reg.resolve(id.sha256)).toBeNull()
    fs.rmdirSync(rom)
    fs.copyFileSync(sparseFile(MAX_ROM_FILE_BYTES + 1), rom)
    expect(reg.resolve(id.sha256)).toBeNull()
  })
  it.skipIf(!theiaInstalled)('identifyRom refuses a directory and an oversize file', async () => {
    const { ProjectServiceImpl } = await import('../../../theia/extension/src/node/project-server')
    const s = new ProjectServiceImpl()
    await expect(s.identifyRom(tmp)).rejects.toThrow(NOT_FILE)
    await expect(s.identifyRom(sparseFile(MAX_ROM_FILE_BYTES + 1))).rejects.toThrow(/too large/)
  })
})

describe('project name validation on create', () => {
  // Written as escapes so the backslash and the control characters are visible.
  const bad = [
    '../x',
    'a/b',
    'a\\b',
    'CON',
    'con.txt',
    'NUL',
    'COM1',
    'x.',
    'x ',
    ' ',
    '',
    '.',
    '..',
    'a:b',
    'a*b',
    'a?b',
    'a|b',
    'a<b',
    'a>b',
    'a"b',
    'a\u0001b',
    'a'.repeat(201),
    5 as unknown as string,
  ]
  for (const name of bad) {
    it(`refuses ${JSON.stringify(name)} and leaves no directory behind`, () => {
      const directory = path.join(tmp, 'proj')
      expect(() => createProject({ romPath: smallRom(), name, directory })).toThrow(/name/i)
      expect(() => createProject({ romPath: smallRom(), name, directory })).not.toThrow(TypeError)
      expect(fs.existsSync(directory)).toBe(false)
    })
  }
  it('accepts a 200-character name', () => {
    const p = createProject({
      romPath: smallRom(),
      name: 'a'.repeat(200),
      directory: path.join(tmp, 'long'),
    })
    expect(fs.existsSync(p.manifestPath)).toBe(true)
  })

  it('refuses to replace a manifest that appears after the occupancy check (wx)', () => {
    const directory = path.join(tmp, 'w')
    fs.mkdirSync(directory)
    fs.writeFileSync(path.join(directory, 'ok.hbproj'), 'planted')
    // The occupancy check would trip first; hide the planted file from it so
    // only the exclusive create can refuse.
    vi.mocked(fs.readdirSync).mockReturnValueOnce([])
    expect(() => createProject({ romPath: smallRom(), name: 'ok', directory })).toThrow(/EEXIST/)
    expect(fs.readFileSync(path.join(directory, 'ok.hbproj'), 'utf8')).toBe('planted')
    // Manifest goes first, so the refusal left no data directories behind.
    expect(fs.existsSync(path.join(directory, 'levels'))).toBe(false)
  })
})

describe('manifest name and shape on open', () => {
  function created(dir = 'g') {
    return createProject({ romPath: smallRom(), name: 'ok', directory: path.join(tmp, dir) })
  }
  function rewrite(manifestPath: string, change: (m: Record<string, unknown>) => void) {
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
    change(raw)
    fs.writeFileSync(manifestPath, JSON.stringify(raw))
  }

  for (const name of ['../../x', 'a/b', 'a\\b', '.', '..', 'a\u0001b', '', 5]) {
    it(`refuses a manifest named ${JSON.stringify(name)}`, () => {
      const p = created()
      rewrite(p.manifestPath, m => (m.name = name))
      expect(() => openProject(p.manifestPath)).toThrow(/name/i)
    })
  }

  it('a name that is only Windows-unsafe still opens, and exporting it refuses with a reason', () => {
    const p = created()
    rewrite(p.manifestPath, m => (m.name = 'Mario: Return'))
    const opened = openProject(p.manifestPath)
    expect(opened.name).toBe('Mario: Return')
    expect(() =>
      exportPatch(opened.directory, opened.name, new WorkingRom(new Uint8Array(0x80000), false)),
    ).toThrow(/Cannot export.*Windows filename/)
  })

  it('a manifest without baseRom is unreadable through the registry, not a TypeError', () => {
    const p = created()
    rewrite(p.manifestPath, m => delete m.baseRom)
    expect(() => openProject(p.manifestPath)).toThrow(/baseRom/)
    const reg = new WorkingRomRegistry(new RomRegistry(path.join(tmp, 'reg.json')))
    expect(reg.get(p.manifestPath)).toMatchObject({
      status: 'unreadable',
      reason: expect.stringMatching(/baseRom/),
    })
  })

  const shapes: [string, (m: Record<string, unknown>) => void, RegExp][] = [
    [
      'baseRom.sha256 not a string',
      m => (m.baseRom = { sha256: 5, size: 1, title: 't' }),
      /baseRom/,
    ],
    [
      'baseRom.size not a number',
      m => (m.baseRom = { sha256: 'a', size: '1', title: 't' }),
      /baseRom/,
    ],
    [
      'baseRom.title not a string',
      m => (m.baseRom = { sha256: 'a', size: 1, title: 7 }),
      /baseRom/,
    ],
    ['title not a string', m => (m.title = 3), /title/],
    ['version not a string', m => (m.version = 3), /version/],
    ['summary not a string', m => (m.summary = {}), /summary/],
    ['authors holds a non-string', m => (m.authors = ['a', 2]), /authors/],
    ['authors is a number', m => (m.authors = 4), /authors/],
  ]
  for (const [label, change, re] of shapes) {
    it(`refuses ${label} with a clear reason`, () => {
      const p = created()
      rewrite(p.manifestPath, change)
      expect(() => openProject(p.manifestPath)).toThrow(re)
      expect(() => openProject(p.manifestPath)).not.toThrow(TypeError)
    })
  }

  it('refuses a manifest that is JSON null', () => {
    const p = created()
    fs.writeFileSync(p.manifestPath, 'null')
    expect(() => openProject(p.manifestPath)).toThrow(/schema version|malformed/)
    expect(() => openProject(p.manifestPath)).not.toThrow(TypeError)
  })

  it('open and update refuse an oversize manifest', () => {
    const p = created()
    fs.writeFileSync(p.manifestPath, Buffer.alloc(MAX_MANIFEST_BYTES + 1, 0x20))
    expect(() => openProject(p.manifestPath)).toThrow(/too large/)
    expect(() => updateProject(p.manifestPath, { title: 'x' })).toThrow(/too large/)
  })
})

describe('WorkingRomRegistry builds from the verified bytes', () => {
  it('does not re-read the path after resolveVerified', () => {
    const regFile = path.join(tmp, 'reg.json')
    const p = createProject({ romPath: smallRom(), name: 'ok', directory: path.join(tmp, 'v') })
    const reg = new RomRegistry(regFile)
    reg.register(path.join(tmp, 'a.sfc'))
    const original = reg.resolveVerified(p.baseRom.sha256)
    expect(original).not.toBeNull()
    const spy = vi.spyOn(reg, 'resolveVerified').mockImplementation(sha => {
      const r = original && p.baseRom.sha256 === sha ? original : null
      // Swap the file after verification: a re-read would now see other bytes.
      fs.writeFileSync(path.join(tmp, 'a.sfc'), new Uint8Array(0x80000).fill(7))
      return r
    })
    const r = new WorkingRomRegistry(reg).get(p.manifestPath)
    expect(spy).toHaveBeenCalled()
    expect(r.status).toBe('ok')
    if (r.status === 'ok') expect(r.working.bytes()[0]).toBe(0)
  })
})

describe('exportPatch guards', () => {
  const working = () => new WorkingRom(new Uint8Array(0x80000), false)
  it('refuses a format that is not bps or ips', () => {
    expect(() => exportPatch(tmp, 'x', working(), '../../evil' as never)).toThrow(/format/)
  })
  it('refuses a name that would leave export/', () => {
    expect(() => exportPatch(tmp, '../x', working(), 'ips')).toThrow(/name|filename/i)
    expect(fs.existsSync(path.join(tmp, '..', 'x.ips'))).toBe(false)
  })
  it('refuses when export/ is a junction to a directory outside the project', () => {
    const project = path.join(tmp, 'proj')
    const outside = path.join(tmp, 'outside')
    fs.mkdirSync(project)
    fs.mkdirSync(outside)
    fs.symlinkSync(outside, path.join(project, 'export'), 'junction')
    expect(() => exportPatch(project, 'x', working(), 'ips')).toThrow(/outside the project/)
    expect(fs.readdirSync(outside)).toEqual([])
  })
  it('refuses to write through a link planted at the target', () => {
    const project = path.join(tmp, 'proj2')
    fs.mkdirSync(path.join(project, 'export'), { recursive: true })
    const victim = path.join(tmp, 'victim.txt')
    fs.writeFileSync(victim, 'keep')
    // A junction (no privilege needed on Windows) reads as a link to lstat.
    fs.symlinkSync(tmp, path.join(project, 'export', 'x.ips'), 'junction')
    expect(() => exportPatch(project, 'x', working(), 'ips')).toThrow(/link/)
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
  })
})

// The reader is bundled and run in a child because a FIFO open without
// O_NONBLOCK blocks the whole thread: an in-process test could not time out.
function readInChild(target: string): { status: number | null; stderr: string } {
  const out = path.join(tmp, 'br.cjs')
  buildSync({
    entryPoints: [path.resolve(__dirname, '../../../src/project/BoundedRead.ts')],
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile: out,
    logLevel: 'silent',
  })
  const script = `try { require(${JSON.stringify(out)}).readRomBounded(${JSON.stringify(target)}) } catch (e) { console.error(e.message); process.exit(3) }`
  const r = spawnSync(process.execPath, ['-e', script], { timeout: 5000, encoding: 'utf8' })
  return { status: r.status, stderr: r.stderr }
}

describe('reader in a child process', () => {
  it('refuses a directory (proves the harness)', () => {
    const r = readInChild(tmp)
    expect(r.status).toBe(3)
    expect(r.stderr).toMatch(NOT_FILE)
  })
  describe.skipIf(process.platform === 'win32')('POSIX only', () => {
    it('refuses a FIFO without hanging', () => {
      const fifo = path.join(tmp, 'pipe')
      execFileSync('mkfifo', [fifo])
      const r = readInChild(fifo)
      expect(r.status).toBe(3)
      expect(r.stderr).toMatch(NOT_FILE)
    })
    it('export refuses a file symlink at the target', () => {
      const project = path.join(tmp, 'proj3')
      fs.mkdirSync(path.join(project, 'export'), { recursive: true })
      const victim = path.join(tmp, 'victim3.txt')
      fs.writeFileSync(victim, 'keep')
      fs.symlinkSync(victim, path.join(project, 'export', 'x.ips'), 'file')
      expect(() =>
        exportPatch(project, 'x', new WorkingRom(new Uint8Array(0x80000), false), 'ips'),
      ).toThrow(/link/)
      expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
    })
  })
})

describe('export over a hard link', () => {
  it('replaces the link and leaves the file it pointed at unchanged', () => {
    const project = path.join(tmp, 'proj4')
    fs.mkdirSync(path.join(project, 'export'), { recursive: true })
    const victim = path.join(tmp, 'victim4.txt')
    fs.writeFileSync(victim, 'keep')
    fs.linkSync(victim, path.join(project, 'export', 'x.ips'))
    exportPatch(project, 'x', new WorkingRom(new Uint8Array(0x80000), false), 'ips')
    expect(fs.readFileSync(victim, 'utf8')).toBe('keep')
    expect(
      fs
        .readFileSync(path.join(project, 'export', 'x.ips'))
        .subarray(0, 5)
        .toString(),
    ).toBe('PATCH')
    expect(fs.readdirSync(path.join(project, 'export'))).toEqual(['x.ips'])
  })
})

describe('updateProject merges the bytes it validated', () => {
  it('reads the manifest once, so a swap after validation cannot reach the write', async () => {
    const p = createProject({ romPath: smallRom(), name: 'ok', directory: path.join(tmp, 'u') })
    const actual = await vi.importActual<typeof import('fs')>('fs')
    let reads = 0
    vi.mocked(fs.openSync).mockImplementation(((file: fs.PathLike, ...rest: never[]) => {
      if (String(file) === p.manifestPath && ++reads === 2) {
        // The planted defect: a malformed manifest appears between reads.
        const raw = JSON.parse(actual.readFileSync(p.manifestPath, 'utf8'))
        actual.writeFileSync(p.manifestPath, JSON.stringify({ ...raw, title: 3, summary: {} }))
      }
      return actual.openSync(file, ...rest)
    }) as typeof fs.openSync)
    try {
      const updated = updateProject(p.manifestPath, { title: 'new' })
      expect(updated.title).toBe('new')
      expect(reads).toBe(1)
    } finally {
      vi.mocked(fs.openSync).mockImplementation(actual.openSync)
    }
  })
})
