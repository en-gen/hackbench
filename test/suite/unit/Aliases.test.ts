/**
 * User-supplied names for things the cartridge does not name.
 *
 * Music tracks have no names anywhere in a ROM. The names in the
 * disassembly's constants.asm (ATHLETIC, CASTLE, ...) describe a stock
 * cartridge and are wrong on a hack - all three AddmusicK carts in this
 * repo's corpus point their eight level-music slots at BGM $0A-$12, which
 * under stock naming reads GAMEOVER, KEYHOLE, BOSSCLEAR, SPOTLIGHT. So the
 * names come from the user, and they persist with the project.
 *
 * Namespaced from the start because the same problem applies to maps:
 * translevel ids are not memorable either (issue #396).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createProject } from '../../../src/project/Project'
import { aliasKey, readAliases, setAlias, ALIAS_MAX_LENGTH } from '../../../src/project/Aliases'

let tmp: string
let manifestPath: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-alias-'))
  const romPath = path.join(tmp, 'base.sfc')
  fs.writeFileSync(romPath, Buffer.alloc(0x80000, 0x00))
  manifestPath = createProject({
    romPath,
    name: 'MyHack',
    directory: path.join(tmp, 'MyHack'),
  }).manifestPath
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

const readManifest = (): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(manifestPath, 'utf8')) as Record<string, unknown>

describe('aliasKey', () => {
  it('renders a byte as two uppercase hex digits', () => {
    expect(aliasKey(0x01)).toBe('01')
    expect(aliasKey(0x1d)).toBe('1D')
  })

  it('does not truncate an id wider than a byte, so map ids fit', () => {
    expect(aliasKey(0x105)).toBe('105')
    expect(aliasKey(0x1ff)).toBe('1FF')
  })

  it('never collides two different ids onto one key', () => {
    const keys = new Set<string>()
    for (let id = 0; id <= 0x1ff; id++) keys.add(aliasKey(id))

    expect(keys.size).toBe(0x200)
  })
})

describe('readAliases', () => {
  it('is empty for a project that has never named anything', () => {
    expect(readAliases(manifestPath, 'music.level')).toEqual({})
  })

  it('returns only the namespace asked for', () => {
    setAlias(manifestPath, 'music.level', 0x01, 'Main theme')
    setAlias(manifestPath, 'map', 0x105, 'Sky bridge')

    expect(readAliases(manifestPath, 'music.level')).toEqual({ '01': 'Main theme' })
    expect(readAliases(manifestPath, 'map')).toEqual({ '105': 'Sky bridge' })
  })

  it('keeps the three music banks apart, because a command means a different song in each', () => {
    // BGM $02 is OVERWORLD in the level bank and DONUTPLAINS in the
    // overworld bank. One flat table would make naming either rename both.
    setAlias(manifestPath, 'music.level', 0x02, 'Grass')
    setAlias(manifestPath, 'music.overworld', 0x02, 'World map 1')

    expect(readAliases(manifestPath, 'music.level')['02']).toBe('Grass')
    expect(readAliases(manifestPath, 'music.overworld')['02']).toBe('World map 1')
  })

  it('tolerates a hand-edited key written with a $ or an odd width', () => {
    const m = readManifest()
    m.aliases = { 'music.level': { $0b: 'Boss', '1': 'First', '1D': 'Last' } }
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))

    expect(readAliases(manifestPath, 'music.level')).toEqual({
      '0B': 'Boss',
      '01': 'First',
      '1D': 'Last',
    })
  })

  it('ignores a non-string value rather than putting it in front of the user', () => {
    const m = readManifest()
    m.aliases = { 'music.level': { '01': 42, '02': 'Real' } }
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))

    expect(readAliases(manifestPath, 'music.level')).toEqual({ '02': 'Real' })
  })
})

/** Built at runtime so no control byte is embedded in this source file. */
const NUL = String.fromCharCode(0)
const LF = String.fromCharCode(10)

describe('setAlias', () => {
  it('round-trips through the manifest on disk', () => {
    setAlias(manifestPath, 'music.level', 0x05, 'Boss fight')

    expect(readAliases(manifestPath, 'music.level')).toEqual({ '05': 'Boss fight' })
  })

  it('replaces an existing name for the same id', () => {
    setAlias(manifestPath, 'music.level', 0x05, 'Boss fight')
    setAlias(manifestPath, 'music.level', 0x05, 'Reznor')

    expect(readAliases(manifestPath, 'music.level')).toEqual({ '05': 'Reznor' })
  })

  it('removes the entry when the name is cleared', () => {
    setAlias(manifestPath, 'music.level', 0x05, 'Boss fight')
    setAlias(manifestPath, 'music.level', 0x05, '   ')

    expect(readAliases(manifestPath, 'music.level')).toEqual({})
  })

  it('drops an emptied namespace rather than leaving a husk in the manifest', () => {
    setAlias(manifestPath, 'music.level', 0x05, 'Boss')
    setAlias(manifestPath, 'music.level', 0x05, '')

    expect(readManifest().aliases).toBeUndefined()
  })

  it('trims surrounding whitespace, so a stray space is not a different name', () => {
    setAlias(manifestPath, 'music.level', 0x05, '  Boss fight  ')

    expect(readAliases(manifestPath, 'music.level')['05']).toBe('Boss fight')
  })

  it('refuses a name longer than the cap rather than bloating the manifest', () => {
    expect(() =>
      setAlias(manifestPath, 'music.level', 0x05, 'x'.repeat(ALIAS_MAX_LENGTH + 1)),
    ).toThrow(/too long/i)
    expect(readAliases(manifestPath, 'music.level')).toEqual({})
  })

  it('strips control characters, which would corrupt the list rendering', () => {
    // Escapes rather than literal control bytes, so the source file itself
    // stays clean: a NUL embedded in a .ts file breaks grep and diff tools.
    setAlias(manifestPath, 'music.level', 0x05, `Boss${NUL}${LF}fight`)

    expect(readAliases(manifestPath, 'music.level')['05']).toBe('Bossfight')
  })

  it('preserves manifest fields this build does not know about', () => {
    // Same rule as updateProject: a collaborator on a newer HackBench must
    // not lose data because someone on an older one renamed a track.
    const m = readManifest()
    m.somethingNewer = { keep: true }
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))

    setAlias(manifestPath, 'music.level', 0x05, 'Boss')

    expect(readManifest().somethingNewer).toEqual({ keep: true })
  })

  it('leaves the project metadata alone', () => {
    const before = readManifest()
    setAlias(manifestPath, 'music.level', 0x05, 'Boss')
    const after = readManifest()

    expect(after.name).toBe(before.name)
    expect(after.baseRom).toEqual(before.baseRom)
    expect(after.created).toBe(before.created)
  })

  it('refuses a project whose manifest cannot be opened, before writing anything', () => {
    const missing = path.join(tmp, 'nope', 'Nope.hbproj')

    expect(() => setAlias(missing, 'music.level', 0x05, 'Boss')).toThrow()
    expect(fs.existsSync(missing)).toBe(false)
  })

  it('refuses a manifest from a future schema rather than writing into it', () => {
    // The file is perfectly readable, so only the openProject round-trip
    // catches this. A later build may mean something different by
    // `aliases`, and overwriting it would discard that meaning.
    const m = readManifest()
    m.schemaVersion = 99
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))

    expect(() => setAlias(manifestPath, 'music.level', 0x05, 'Boss')).toThrow(/schema version/i)
    expect(readManifest().aliases).toBeUndefined()
  })

  it('overwrites a hand-written key rather than storing a second spelling', () => {
    // `$05` and `05` are the same track. Writing the canonical key without
    // clearing the other leaves two entries, and which one wins on read is
    // then down to object key order.
    const m = readManifest()
    m.aliases = { 'music.level': { $05: 'Old name' } }
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))

    setAlias(manifestPath, 'music.level', 0x05, 'New name')

    expect(readAliases(manifestPath, 'music.level')).toEqual({ '05': 'New name' })
    expect(Object.keys((readManifest().aliases as Record<string, object>)['music.level'])).toEqual([
      '05',
    ])
  })

  it('clears a hand-written key when the name is emptied', () => {
    const m = readManifest()
    m.aliases = { 'music.level': { $05: 'Old name' } }
    fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2))

    setAlias(manifestPath, 'music.level', 0x05, '')

    expect(readAliases(manifestPath, 'music.level')).toEqual({})
  })
})
