/**
 * Object definitions: the boundaries a review found. Synthetic only, no ROM.
 * Reader rules are the doc's (docs/architecture/object-definitions.md) and
 * stay as written; the writer-only rules (exact-case file, reserved Windows
 * names, a name that is text) are tested as such.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  deleteObjectDefinition,
  isWritableId,
  objectsDir,
  OBJECT_FILE_MAX_BYTES,
  ObjectLimits,
  readObjectDefinitions,
  renameObjectDefinition,
  saveObjectDefinition,
} from '../../../src/project/ObjectDefinitions'

const LIMITS: ObjectLimits = { tilesetCount: 15, tileCount: 512 }

let dir: string
let objects: string

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-objects-b-'))
  objects = objectsDir(dir)
  fs.mkdirSync(objects, { recursive: true })
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function good(over: Record<string, unknown> = {}, id = 'aaaa0001'): Record<string, unknown> {
  return { version: 1, id, name: 'Platform', tileset: 1, edge: [256, 257], fill: [258], ...over }
}

function put(stem: string, body: unknown): void {
  fs.writeFileSync(
    path.join(objects, `${stem}.json`),
    typeof body === 'string' || Buffer.isBuffer(body) ? body : JSON.stringify(body),
  )
}

const reasonOf = (stem: string): string | undefined =>
  readObjectDefinitions(dir, LIMITS).skipped.find(s => s.file === `${stem}.json`)?.reason

const draft = { name: 'Platform', tileset: 2, edge: [259, 256], fill: [300, 301] }

/** A probe, not an assumption: Windows and macOS usually are, Linux usually is not. */
function fileSystemIsCaseInsensitive(): boolean {
  const probe = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-case-'))
  try {
    fs.writeFileSync(path.join(probe, 'Aa.txt'), '')
    return fs.existsSync(path.join(probe, 'aa.txt'))
  } finally {
    fs.rmSync(probe, { recursive: true, force: true })
  }
}

describe('file size, exactly at the cap', () => {
  it('loads a file of exactly 64 KiB and skips one a byte over', () => {
    const body = JSON.stringify(good({}, 'exact001'))
    put('exact001', body + ' '.repeat(OBJECT_FILE_MAX_BYTES - body.length))
    const over = JSON.stringify(good({}, 'over0001'))
    put('over0001', over + ' '.repeat(OBJECT_FILE_MAX_BYTES + 1 - over.length))
    expect(fs.statSync(path.join(objects, 'exact001.json')).size).toBe(OBJECT_FILE_MAX_BYTES)
    expect(fs.statSync(path.join(objects, 'over0001.json')).size).toBe(OBJECT_FILE_MAX_BYTES + 1)

    const r = readObjectDefinitions(dir, LIMITS)
    expect(r.definitions.map(d => d.id)).toEqual(['exact001'])
    expect(r.skipped).toEqual([{ file: 'over0001.json', reason: 'The file is larger than 64 KB.' }])
  })
})

describe('skip reasons, word for word', () => {
  it('says the right thing for versions 0, null, "1", a missing version and a newer one', () => {
    put('v0', good({ version: 0 }, 'v0'))
    put('vnull', good({ version: null }, 'vnull'))
    put('vstr', good({ version: '1' }, 'vstr'))
    put('vnone', good({ version: undefined }, 'vnone'))
    put('vnew', good({ version: 2 }, 'vnew'))
    expect(reasonOf('v0')).toBe("The file's version (0) is not one this HackBench knows.")
    expect(reasonOf('vnull')).toBe("The file's version (null) is not one this HackBench knows.")
    expect(reasonOf('vstr')).toBe('The file\'s version ("1") is not one this HackBench knows.')
    expect(reasonOf('vnone')).toBe('The file has no version.')
    expect(reasonOf('vnew')).toBe('This Object was saved by a newer HackBench.')
  })

  it('refuses a 65-character id in a file, and a file with no fill list', () => {
    const long = 'a'.repeat(65)
    put(long, good({}, long))
    put('nofill01', good({ fill: undefined }, 'nofill01'))
    expect(reasonOf(long)).toBe('The file has no usable id.')
    expect(reasonOf('nofill01')).toBe('"fill" is not a list of tile numbers.')
    // 64 characters is the longest usable id.
    const max = 'a'.repeat(64)
    put(max, good({}, max))
    expect(readObjectDefinitions(dir, LIMITS).definitions.map(d => d.id)).toEqual([max])
  })

  it('skips a file with a byte order mark, and says how to fix it', () => {
    put(
      'bom00001',
      Buffer.concat([
        Buffer.from([0xef, 0xbb, 0xbf]),
        Buffer.from(JSON.stringify(good({}, 'bom00001'))),
      ]),
    )
    expect(reasonOf('bom00001')).toBe(
      'The file was saved with a byte order mark; save it as UTF-8 without one.',
    )
  })

  it('names the other reasons in plain words', () => {
    put('notjson1', '{ nope')
    put('notobj01', '[1]')
    put('noid0001', good({ id: undefined }, 'noid0001'))
    put('mism0001', good({ id: 'other001' }, 'mism0001'))
    put('noname01', good({ name: ' ' }, 'noname01'))
    put('tsstr001', good({ tileset: '1' }, 'tsstr001'))
    put('edgebad1', good({ edge: [1.5] }, 'edgebad1'))
    put('overlap1', good({ edge: [1, 2], fill: [2] }, 'overlap1'))
    put('past0001', good({ fill: [512] }, 'past0001'))
    put('negtile1', good({ edge: [-1] }, 'negtile1'))
    put('tsout001', good({ tileset: 15 }, 'tsout001'))
    expect(reasonOf('notjson1')).toBe('The file is not readable JSON.')
    expect(reasonOf('notobj01')).toBe('The file does not hold one Object definition.')
    expect(reasonOf('noid0001')).toBe('The file has no usable id.')
    expect(reasonOf('mism0001')).toBe('The id "other001" does not match the file name.')
    expect(reasonOf('noname01')).toBe('The file has no name.')
    expect(reasonOf('tsstr001')).toBe('The file has no whole-number tileset.')
    expect(reasonOf('edgebad1')).toBe('"edge" holds something that is not a whole tile number.')
    expect(reasonOf('overlap1')).toBe('Tile number 2 is tagged as both edge and fill.')
    expect(reasonOf('past0001')).toBe(
      'Tile number 512 in "fill" is not in this ROM\'s Map16 (0 to 511).',
    )
    expect(reasonOf('negtile1')).toBe(
      'Tile number -1 in "edge" is not in this ROM\'s Map16 (0 to 511).',
    )
    expect(reasonOf('tsout001')).toBe('Tileset 15 is not one this ROM has (0 to 14).')
  })
})

describe('a name that is not text never throws at the caller', () => {
  it('refuses it on save and on rename', () => {
    for (const name of [5, null, undefined, {}, ['x']]) {
      const r = saveObjectDefinition(dir, LIMITS, { ...draft, name } as never)
      expect(r.status).toBe('invalid')
    }
    put('aaaa0001', good())
    for (const name of [5, null, undefined]) {
      expect(renameObjectDefinition(dir, LIMITS, 'aaaa0001', name as never).status).toBe('invalid')
    }
    expect(readObjectDefinitions(dir, LIMITS).definitions[0]!.name).toBe('Platform')
  })
})

describe('reserved Windows names (writer only)', () => {
  it('refuses to save under them, and under no other id of the same shape', () => {
    for (const id of ['con', 'prn', 'aux', 'nul', 'com1', 'com9', 'lpt1', 'lpt9']) {
      expect(isWritableId(id)).toBe(false)
      expect(saveObjectDefinition(dir, LIMITS, { ...draft, id }).status).toBe('invalid')
    }
    for (const id of ['com0', 'com10', 'console', 'lpt', 'cat']) {
      expect(isWritableId(id)).toBe(true)
    }
    expect(fs.readdirSync(objects)).toEqual([])
  })

  it('still reads such a file: the rule is for writers', () => {
    put('con', good({}, 'con'))
    expect(readObjectDefinitions(dir, LIMITS).definitions.map(d => d.id)).toEqual(['con'])
  })
})

describe('unknown fields', () => {
  it('survive a rename', () => {
    put('aaaa0001', good({ facing: { 256: 'top' } }))
    expect(renameObjectDefinition(dir, LIMITS, 'aaaa0001', 'Renamed').status).toBe('ok')
    const stored = JSON.parse(fs.readFileSync(path.join(objects, 'aaaa0001.json'), 'utf8'))
    expect(stored.facing).toEqual({ 256: 'top' })
    expect(stored.name).toBe('Renamed')
  })
})

describe.skipIf(!fileSystemIsCaseInsensitive())(
  'a file under different capitals (case-insensitive file system)',
  () => {
    it('is never overwritten, renamed or deleted through another spelling of its id', () => {
      const planted = JSON.stringify(good({}, 'abc12345'))
      fs.writeFileSync(path.join(objects, 'ABC12345.json'), planted)
      // The reader skips it: its id differs from the file name.
      expect(readObjectDefinitions(dir, LIMITS).skipped.map(s => s.file)).toEqual(['ABC12345.json'])

      for (const result of [
        saveObjectDefinition(dir, LIMITS, { ...draft, id: 'abc12345' }),
        renameObjectDefinition(dir, LIMITS, 'abc12345', 'New name'),
        deleteObjectDefinition(dir, 'abc12345'),
      ]) {
        expect(result.status).toBe('invalid')
      }
      expect(fs.readdirSync(objects)).toEqual(['ABC12345.json'])
      expect(fs.readFileSync(path.join(objects, 'ABC12345.json'), 'utf8')).toBe(planted)
    })
  },
)
