/**
 * Creating and opening a HackBench project.
 *
 * A project is a hack: patch layers plus metadata, against a base ROM the user
 * supplies. It never contains cartridge bytes, which is what makes it safe to
 * share, and that property is asserted directly here rather than inferred from
 * an ignore file.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import { createHash } from 'crypto'
import * as fs from 'fs'
import * as path from 'path'
import * as os from 'os'
import {
  createProject,
  openProject,
  romIdentity,
  SCHEMA_VERSION,
  PROJECT_EXT,
  INITIAL_HACK_VERSION,
  updateProject,
} from '../../../src/project/Project'
import { slow } from '../support/loadTimeout'

const COPIER_HEADER_SIZE = 512

let tmp: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hbproj-'))
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

/**
 * A synthetic cart.
 *
 * Deliberately not a real ROM: these tests are about project mechanics, and a
 * real cart would put copyrighted bytes in the repo. The internal header is
 * placed where a LoROM cart carries it so the title can be read back.
 */
function fakeRom(title = 'SUPER MARIO WORLD  ', size = 0x80000): Uint8Array {
  const rom = new Uint8Array(size)
  for (let i = 0; i < size; i++) rom[i] = (i * 31) & 0xff
  // LoROM internal header title sits at $7FC0, which is file offset 0x7FC0.
  const titleBytes = Buffer.from(title.padEnd(21, ' ').slice(0, 21), 'ascii')
  rom.set(titleBytes, 0x7fc0)
  return rom
}

/** The same cart with a 512-byte copier header glued on the front. */
function withCopierHeader(rom: Uint8Array): Uint8Array {
  const out = new Uint8Array(rom.length + COPIER_HEADER_SIZE)
  // Copier headers carry junk, not zeroes, which is the point: a naive hash
  // of the whole file would differ from the unheadered copy.
  for (let i = 0; i < COPIER_HEADER_SIZE; i++) out[i] = (i * 7 + 3) & 0xff
  out.set(rom, COPIER_HEADER_SIZE)
  return out
}

function writeRom(name: string, bytes: Uint8Array): string {
  const p = path.join(tmp, name)
  fs.writeFileSync(p, bytes)
  return p
}

/** Every file under a directory, recursively, as paths relative to it. */
function walk(dir: string, base = dir): string[] {
  const out: string[] = []
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name)
    if (e.isDirectory()) out.push(...walk(full, base))
    else out.push(path.relative(base, full))
  }
  return out
}

describe('romIdentity', () => {
  it('hashes the cart, not the file, so a copier header does not change it', () => {
    const bare = fakeRom()
    const headered = withCopierHeader(bare)
    expect(headered.length).toBe(bare.length + COPIER_HEADER_SIZE)

    const a = romIdentity(bare)
    const b = romIdentity(headered)

    // The whole point: the same cartridge dumped two ways is one identity.
    // Getting this wrong sends a contributor hunting for a ROM they have.
    expect(b.sha256).toBe(a.sha256)
    expect(b.size).toBe(a.size)
  })

  it('reports the unheadered size, not the file size', () => {
    expect(romIdentity(withCopierHeader(fakeRom())).size).toBe(0x80000)
  })

  it('reads the internal title', () => {
    expect(romIdentity(fakeRom('MY COOL HACK')).title).toBe('MY COOL HACK')
  })

  it('distinguishes genuinely different carts', () => {
    const a = romIdentity(fakeRom())
    const other = fakeRom()
    other[0x1234] ^= 0xff
    expect(romIdentity(other).sha256).not.toBe(a.sha256)
  })
})

describe('createProject', () => {
  it('writes a manifest carrying the schema version and the ROM identity', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const proj = createProject({ romPath, name: 'MyHack', directory: path.join(tmp, 'my-hack') })

    expect(path.basename(proj.manifestPath)).toBe(`MyHack${PROJECT_EXT}`)
    const m = JSON.parse(fs.readFileSync(proj.manifestPath, 'utf8'))
    expect(m.schemaVersion).toBe(SCHEMA_VERSION)
    expect(m.name).toBe('MyHack')
    expect(m.baseRom.sha256).toBe(romIdentity(fakeRom()).sha256)
  })

  it('creates the directories a project needs and nothing else', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const dir = path.join(tmp, 'my-hack')
    createProject({ romPath, name: 'MyHack', directory: dir })

    const entries = fs.readdirSync(dir).sort()
    // No global/, which was several unrelated concerns under one name, and no
    // .cache/, which lives in application data so a project never holds
    // cartridge-derived bytes.
    expect(entries).toEqual(['MyHack.hbproj', 'levels', 'snapshots'])
  })

  /**
   * The property that makes a project shareable at all.
   *
   * Asserted against the directory's actual contents, not against an ignore
   * file, so it holds whether or not the user ever uses git.
   */
  it('puts no cartridge bytes in the project', () => {
    const rom = fakeRom()
    const romPath = writeRom('cart.sfc', rom)
    const dir = path.join(tmp, 'my-hack')
    createProject({ romPath, name: 'MyHack', directory: dir })

    for (const rel of walk(dir)) {
      expect(rel).not.toMatch(/\.(sfc|smc|rom)$/i)
      const bytes = fs.readFileSync(path.join(dir, rel))
      expect(bytes.length).toBeLessThan(rom.length)
    }
  })

  // Worst 4.7 s in 10 runs, 5 concurrent pairs at 38af1126, 32-core machine, 2026-10-10.
  it('does not modify the ROM it was created from', slow(10_000), () => {
    const rom = fakeRom()
    const romPath = writeRom('cart.sfc', rom)
    createProject({ romPath, name: 'MyHack', directory: path.join(tmp, 'my-hack') })
    expect(new Uint8Array(fs.readFileSync(romPath))).toEqual(rom)
  })

  it('refuses a directory that already has something in it', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const dir = path.join(tmp, 'occupied')
    fs.mkdirSync(dir, { recursive: true })
    fs.writeFileSync(path.join(dir, 'notes.txt'), 'mine')

    // Merging into an occupied directory risks adopting files that are not
    // ours, so this fails rather than guessing.
    expect(() => createProject({ romPath, name: 'MyHack', directory: dir })).toThrow(/not empty/i)
    expect(fs.existsSync(path.join(dir, 'notes.txt'))).toBe(true)
  })

  it('refuses a ROM path that does not exist', () => {
    expect(() =>
      createProject({
        romPath: path.join(tmp, 'nope.sfc'),
        name: 'X',
        directory: path.join(tmp, 'p'),
      }),
    ).toThrow()
  })
})

/**
 * What the hack IS, as opposed to what HackBench needs to open it.
 *
 * All optional: someone starting a hack does not yet know its summary, and
 * refusing to create a project until they invent one would be the tool
 * getting in the way.
 */
describe('hack metadata', () => {
  const rom = () => writeRom('cart.sfc', fakeRom())

  it('round-trips title, summary, authors and version', () => {
    const created = createProject({
      romPath: rom(),
      name: 'MyHack',
      directory: path.join(tmp, 'my-hack'),
      title: 'Super Kaizo World ]|[',
      summary: 'A short hack about falling.',
      authors: ['engenb', 'someone else'],
      version: '1.2.0',
    })

    const opened = openProject(created.manifestPath)
    expect(opened.title).toBe('Super Kaizo World ]|[')
    expect(opened.summary).toBe('A short hack about falling.')
    expect(opened.authors).toEqual(['engenb', 'someone else'])
    expect(opened.version).toBe('1.2.0')
  })

  it('lets the title differ from the project name', () => {
    // The manifest's name is a filename stem and so is constrained by the
    // filesystem; a hack title is not.
    const created = createProject({
      romPath: rom(),
      name: 'my-hack',
      directory: path.join(tmp, 'p'),
      title: 'Super Kaizo World ]|[',
    })
    expect(created.name).toBe('my-hack')
    expect(created.title).toBe('Super Kaizo World ]|[')
  })

  it('defaults the title to the project name when none is given', () => {
    const created = createProject({
      romPath: rom(),
      name: 'MyHack',
      directory: path.join(tmp, 'p'),
    })
    expect(created.title).toBe('MyHack')
    expect(created.summary).toBe('')
    expect(created.authors).toEqual([])
    expect(created.version).toBe(INITIAL_HACK_VERSION)
  })

  /**
   * The hack's version belongs to the author and the schema version belongs
   * to the format. Conflating them would make a manifest unreadable the
   * moment someone tagged their hack 2.0.
   */
  it('keeps the hack version independent of the schema version', () => {
    const created = createProject({
      romPath: rom(),
      name: 'MyHack',
      directory: path.join(tmp, 'p'),
      version: '2.0.0',
    })
    const m = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'))
    expect(m.version).toBe('2.0.0')
    expect(m.schemaVersion).toBe(SCHEMA_VERSION)
    expect(openProject(created.manifestPath).version).toBe('2.0.0')
  })

  it('opens a manifest written before these fields existed', () => {
    const created = createProject({
      romPath: rom(),
      name: 'MyHack',
      directory: path.join(tmp, 'p'),
    })
    const m = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'))
    delete m.title
    delete m.summary
    delete m.authors
    delete m.version
    fs.writeFileSync(created.manifestPath, JSON.stringify(m, null, 2))

    // Defaults are applied on READ too, so nothing reaches the UI undefined.
    const opened = openProject(created.manifestPath)
    expect(opened.title).toBe('MyHack')
    expect(opened.authors).toEqual([])
    expect(opened.version).toBe(INITIAL_HACK_VERSION)
  })

  it('does not split a single author written as a bare string', () => {
    const created = createProject({
      romPath: rom(),
      name: 'MyHack',
      directory: path.join(tmp, 'p'),
    })
    const m = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'))
    // What a hand-edited manifest tends to hold. Splitting it on a comma
    // would invent authors who do not exist.
    m.authors = 'engenb, someone else'
    fs.writeFileSync(created.manifestPath, JSON.stringify(m, null, 2))
    expect(openProject(created.manifestPath).authors).toEqual(['engenb, someone else'])
  })
})

describe('updateProject', () => {
  const make = () =>
    createProject({
      romPath: writeRom('cart.sfc', fakeRom()),
      name: 'MyHack',
      directory: path.join(tmp, 'my-hack'),
    })

  it('writes the edited metadata back to the manifest', () => {
    const created = make()
    updateProject(created.manifestPath, {
      title: 'Renamed Hack',
      authors: ['engenb'],
      version: '1.1.0',
      summary: 'Now with more spikes.',
    })

    const opened = openProject(created.manifestPath)
    expect(opened.title).toBe('Renamed Hack')
    expect(opened.authors).toEqual(['engenb'])
    expect(opened.version).toBe('1.1.0')
    expect(opened.summary).toBe('Now with more spikes.')
  })

  it('leaves the fields it was not asked to change alone', () => {
    const created = make()
    updateProject(created.manifestPath, { authors: ['engenb'] })
    updateProject(created.manifestPath, { version: '2.0.0' })

    const opened = openProject(created.manifestPath)
    expect(opened.authors).toEqual(['engenb'])
    expect(opened.version).toBe('2.0.0')
  })

  /**
   * The base ROM is a fact about the project, not an opinion. Letting it be
   * edited here would make the manifest describe a different cartridge while
   * the patch layers still targeted the old one.
   */
  it('never changes the base ROM identity or the creation date', () => {
    const created = make()
    const before = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'))

    updateProject(created.manifestPath, { title: 'Renamed' })

    const after = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'))
    expect(after.baseRom).toEqual(before.baseRom)
    expect(after.created).toBe(before.created)
    expect(after.schemaVersion).toBe(before.schemaVersion)
  })

  /**
   * Forward compatibility. A collaborator on a newer HackBench must not lose
   * data because someone on an older build edited the title.
   */
  it('preserves manifest fields this build does not know about', () => {
    const created = make()
    const m = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'))
    m.somethingFromTheFuture = { kept: true }
    fs.writeFileSync(created.manifestPath, JSON.stringify(m, null, 2))

    updateProject(created.manifestPath, { title: 'Renamed' })

    const after = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'))
    expect(after.somethingFromTheFuture).toEqual({ kept: true })
    expect(after.title).toBe('Renamed')
  })

  it('refuses to write to a manifest it would refuse to open', () => {
    const created = make()
    const m = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'))
    m.schemaVersion = SCHEMA_VERSION + 1
    const text = JSON.stringify(m, null, 2)
    fs.writeFileSync(created.manifestPath, text)

    expect(() => updateProject(created.manifestPath, { title: 'X' })).toThrow(/schema/i)
    // Nothing written: a partial edit to a manifest we do not understand is
    // worse than refusing.
    expect(fs.readFileSync(created.manifestPath, 'utf8')).toBe(text)
  })

  it('falls back to a default rather than storing an empty title', () => {
    const created = make()
    updateProject(created.manifestPath, { title: '   ' })
    expect(openProject(created.manifestPath).title).toBe('MyHack')
  })
})

describe('openProject', () => {
  it('round-trips the ROM identity it was created with', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const created = createProject({
      romPath,
      name: 'MyHack',
      directory: path.join(tmp, 'my-hack'),
    })
    const opened = openProject(created.manifestPath)
    expect(opened.baseRom).toEqual(created.baseRom)
    expect(opened.name).toBe('MyHack')
  })

  /**
   * Data directories are fixed names, not derived from the project name, so
   * renaming the manifest cannot orphan the layers.
   */
  it('still finds the level data after the manifest is renamed', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const dir = path.join(tmp, 'my-hack')
    const created = createProject({ romPath, name: 'MyHack', directory: dir })

    const renamed = path.join(dir, `Renamed${PROJECT_EXT}`)
    fs.renameSync(created.manifestPath, renamed)

    const opened = openProject(renamed)
    expect(fs.existsSync(opened.levelsDir)).toBe(true)
    expect(opened.baseRom).toEqual(created.baseRom)
  })

  it('says plainly when the manifest has been moved away from its data', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const created = createProject({
      romPath,
      name: 'MyHack',
      directory: path.join(tmp, 'my-hack'),
    })
    const orphan = path.join(tmp, `Orphan${PROJECT_EXT}`)
    fs.copyFileSync(created.manifestPath, orphan)

    // Presenting an empty project would look like a hack that lost its work.
    expect(() => openProject(orphan)).toThrow(/data director/i)
  })

  it('refuses a directory holding two manifests', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const dir = path.join(tmp, 'my-hack')
    const created = createProject({ romPath, name: 'MyHack', directory: dir })
    fs.copyFileSync(created.manifestPath, path.join(dir, `Second${PROJECT_EXT}`))

    // Both would claim the same levels/, so picking one silently is wrong.
    expect(() => openProject(created.manifestPath)).toThrow(/more than one/i)
  })

  it('rejects a manifest from a future schema rather than guessing', () => {
    const romPath = writeRom('cart.sfc', fakeRom())
    const created = createProject({
      romPath,
      name: 'MyHack',
      directory: path.join(tmp, 'my-hack'),
    })
    const m = JSON.parse(fs.readFileSync(created.manifestPath, 'utf8'))
    m.schemaVersion = SCHEMA_VERSION + 1
    fs.writeFileSync(created.manifestPath, JSON.stringify(m))

    expect(() => openProject(created.manifestPath)).toThrow(/schema/i)
  })
})

/**
 * Proof the assertions above can go red.
 *
 * Without these, an implementation that copied the ROM into the project would
 * still pass every shape check, and a hash that ignored the copier header
 * would pass everything except one case that has to actually distinguish them.
 */
describe('the oracle can fail', () => {
  it('a project containing the ROM breaks the no-cartridge-bytes check', () => {
    const rom = fakeRom()
    const romPath = writeRom('cart.sfc', rom)
    const dir = path.join(tmp, 'my-hack')
    createProject({ romPath, name: 'MyHack', directory: dir })

    // Plant exactly the defect: copy the cart in, as a naive implementation
    // wanting a self-contained project would.
    fs.copyFileSync(romPath, path.join(dir, 'base.sfc'))

    const offenders = walk(dir).filter(r => /\.(sfc|smc|rom)$/i.test(r))
    expect(offenders.length).toBeGreaterThan(0)
  })

  it('hashing the whole file would split one cart into two identities', () => {
    const bare = fakeRom()
    const headered = withCopierHeader(bare)
    const naive = (b: Uint8Array): string => createHash('sha256').update(b).digest('hex')

    expect(naive(headered)).not.toBe(naive(bare))
    expect(romIdentity(headered).sha256).toBe(romIdentity(bare).sha256)
  })
})
