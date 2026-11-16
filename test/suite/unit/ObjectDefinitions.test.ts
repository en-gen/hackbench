/**
 * Object definitions (docs/architecture/object-definitions.md), synthetic
 * only: every file is built here, so CI needs no ROM.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  deleteObjectDefinition,
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
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-objects-'))
  objects = objectsDir(dir)
})
afterEach(() => {
  fs.rmSync(dir, { recursive: true, force: true })
})

function good(over: Record<string, unknown> = {}, id = 'aaaa0001'): Record<string, unknown> {
  return { version: 1, id, name: 'Platform', tileset: 1, edge: [256, 257], fill: [258], ...over }
}

function put(stem: string, body: unknown): void {
  fs.mkdirSync(objects, { recursive: true })
  fs.writeFileSync(
    path.join(objects, `${stem}.json`),
    typeof body === 'string' ? body : JSON.stringify(body),
  )
}

const draft = { name: 'Platform', tileset: 2, edge: [259, 256], fill: [300, 301] }

describe('readObjectDefinitions', () => {
  it('reads a missing folder as no definitions, not an error', () => {
    expect(readObjectDefinitions(dir, LIMITS)).toEqual({ definitions: [], skipped: [] })
  })

  it('reads every skip reason in the doc from its own file, and the good files still load', () => {
    put('ok000001', good({}, 'ok000001'))
    put('ok000002', good({ edge: [5, 3, 3] }, 'ok000002'))
    const bad: Record<string, unknown> = {
      big: `{"version":1,"pad":"${'x'.repeat(OBJECT_FILE_MAX_BYTES)}"}`,
      notjson: '{ nope',
      notobject: '[1,2]',
      noversion: good({ version: undefined }, 'noversion'),
      newer: good({ version: 2 }, 'newer'),
      strver: good({ version: '1' }, 'strver'),
      noid: good({ id: undefined }, 'noid'),
      badid: good({ id: 'Bad_Id' }, 'badid'),
      mismatch: good({ id: 'other001' }, 'mismatch'),
      noname: good({ name: undefined }, 'noname'),
      blankname: good({ name: '   ' }, 'blankname'),
      strtileset: good({ tileset: '1' }, 'strtileset'),
      fracttileset: good({ tileset: 1.5 }, 'fracttileset'),
      noedge: good({ edge: undefined }, 'noedge'),
      fillnotlist: good({ fill: 'x' }, 'fillnotlist'),
      fractile: good({ edge: [1.5] }, 'fractile'),
      strtile: good({ fill: ['4'] }, 'strtile'),
      overlap: good({ edge: [1, 2], fill: [2, 3] }, 'overlap'),
      negtile: good({ edge: [-1] }, 'negtile'),
      pasttile: good({ fill: [512] }, 'pasttile'),
      othertileset: good({ tileset: 15 }, 'othertileset'),
      negtileset: good({ tileset: -1 }, 'negtileset'),
    }
    for (const [stem, body] of Object.entries(bad)) put(stem, body)
    // Not definitions at all: a leftover temp, a subfolder, a stray file.
    fs.writeFileSync(path.join(objects, 'ok000001.json.123.tmp'), '{}')
    fs.mkdirSync(path.join(objects, 'sub.json'))
    fs.writeFileSync(path.join(objects, 'notes.txt'), 'hi')

    const r = readObjectDefinitions(dir, LIMITS)
    expect(r.definitions.map(d => d.id).sort()).toEqual(['ok000001', 'ok000002'])
    expect(r.definitions.find(d => d.id === 'ok000002')!.edge).toEqual([3, 5])
    expect(r.skipped.map(s => s.file).sort()).toEqual(
      Object.keys(bad)
        .map(k => `${k}.json`)
        .sort(),
    )
    for (const s of r.skipped) expect(s.reason.length).toBeGreaterThan(10)
    const why = (stem: string) => r.skipped.find(s => s.file === `${stem}.json`)!.reason
    expect(why('big')).toMatch(/larger than 64 KB/)
    expect(why('notjson')).toMatch(/not readable JSON/)
    expect(why('newer')).toMatch(/newer HackBench/)
    expect(why('mismatch')).toMatch(/does not match the file name/)
    expect(why('overlap')).toMatch(/both edge and fill/)
    expect(why('pasttile')).toMatch(/not in this ROM's Map16/)
    expect(why('othertileset')).toMatch(/not one this ROM has/)
  })

  it('skips every file with the reason when the ROM cannot say its tile count', () => {
    put('aaaa0001', good())
    const r = readObjectDefinitions(dir, {
      ...LIMITS,
      unavailable: 'This ROM has an expanded Map16.',
    })
    expect(r.definitions).toEqual([])
    expect(r.skipped).toEqual([
      { file: 'aaaa0001.json', reason: 'This ROM has an expanded Map16.' },
    ])
  })

  it('leaves every file byte-identical, readable or not', () => {
    put('aaaa0001', good())
    put('broken', '{ nope')
    const before = fs
      .readdirSync(objects)
      .map(f => [f, fs.readFileSync(path.join(objects, f), 'utf8')])
    readObjectDefinitions(dir, LIMITS)
    const after = fs
      .readdirSync(objects)
      .map(f => [f, fs.readFileSync(path.join(objects, f), 'utf8')])
    expect(after).toEqual(before)
  })

  it('ignores fields it does not know', () => {
    put('aaaa0001', good({ facing: { 256: 'top' } }))
    expect(readObjectDefinitions(dir, LIMITS).definitions).toHaveLength(1)
  })
})

describe('saveObjectDefinition', () => {
  it('round-trips: sorted, disjoint, version 1, stored under its own id', () => {
    const r = saveObjectDefinition(dir, LIMITS, draft)
    expect(r.status).toBe('ok')
    if (r.status !== 'ok') return
    expect(r.definition).toMatchObject({
      version: 1,
      tileset: 2,
      edge: [256, 259],
      fill: [300, 301],
    })
    expect(r.definition.id).toMatch(/^[0-9a-f]{8}$/)
    const stored = JSON.parse(
      fs.readFileSync(path.join(objects, `${r.definition.id}.json`), 'utf8'),
    )
    expect(stored).toEqual(r.definition)
    expect(readObjectDefinitions(dir, LIMITS)).toEqual({ definitions: [r.definition], skipped: [] })
  })

  it('keeps the fill list (planted-defect target: dropping fill must turn this red)', () => {
    const r = saveObjectDefinition(dir, LIMITS, draft)
    if (r.status !== 'ok') throw new Error('save refused')
    const onDisk = JSON.parse(
      fs.readFileSync(path.join(objects, `${r.definition.id}.json`), 'utf8'),
    )
    expect(onDisk.fill).toEqual([300, 301])
    expect(readObjectDefinitions(dir, LIMITS).definitions[0]!.fill).toEqual([300, 301])
  })

  it('saves again under the same id without making a second file', () => {
    const a = saveObjectDefinition(dir, LIMITS, draft)
    if (a.status !== 'ok') throw new Error('save refused')
    const b = saveObjectDefinition(dir, LIMITS, { ...draft, id: a.definition.id, fill: [400] })
    expect(b.status).toBe('ok')
    expect(fs.readdirSync(objects)).toHaveLength(1)
    expect(readObjectDefinitions(dir, LIMITS).definitions[0]!.fill).toEqual([400])
  })

  it('refuses, in words, and writes nothing, for each bad draft', () => {
    const cases: Array<[Partial<typeof draft>, RegExp]> = [
      [{ name: '  ' }, /no name/],
      [{ tileset: 15 }, /not one this ROM has/],
      [{ tileset: 99 }, /not one this ROM has/],
      [{ edge: [512] }, /not in this ROM's Map16/],
      [{ fill: [-1] }, /not in this ROM's Map16/],
      [{ edge: [1, 2], fill: [2] }, /both edge and fill/],
      [{ edge: [1.5] }, /whole tile number/],
    ]
    for (const [over, re] of cases) {
      const r = saveObjectDefinition(dir, LIMITS, { ...draft, ...over })
      expect(r.status).toBe('invalid')
      if (r.status === 'invalid') expect(r.reason).toMatch(re)
    }
    expect(fs.existsSync(objects)).toBe(false)
  })

  it('refuses a save when the ROM cannot say its tile count', () => {
    const r = saveObjectDefinition(dir, { ...LIMITS, unavailable: 'No Map16.' }, draft)
    expect(r).toEqual({ status: 'invalid', reason: 'No Map16.' })
  })

  it('never overwrites a file the reader skipped, and leaves it as found', () => {
    put('aaaa0001', '{ nope')
    const r = saveObjectDefinition(dir, LIMITS, { ...draft, id: 'aaaa0001' })
    expect(r.status).toBe('invalid')
    expect(fs.readFileSync(path.join(objects, 'aaaa0001.json'), 'utf8')).toBe('{ nope')
  })

  it('refuses an unusable id', () => {
    for (const id of ['../x', 'A', '', 'a'.repeat(65)]) {
      expect(saveObjectDefinition(dir, LIMITS, { ...draft, id }).status).toBe('invalid')
    }
  })

  it('keeps fields it does not know when it saves over a file', () => {
    put('aaaa0001', good({ facing: { 256: 'top' } }))
    saveObjectDefinition(dir, LIMITS, { ...draft, id: 'aaaa0001' })
    const stored = JSON.parse(fs.readFileSync(path.join(objects, 'aaaa0001.json'), 'utf8'))
    expect(stored.facing).toEqual({ 256: 'top' })
  })
})

describe('renameObjectDefinition', () => {
  it('rewrites the name in the same file and keeps id, tileset and tags', () => {
    const a = saveObjectDefinition(dir, LIMITS, draft)
    if (a.status !== 'ok') throw new Error('save refused')
    const r = renameObjectDefinition(dir, LIMITS, a.definition.id, '  Pipe ')
    expect(r.status).toBe('ok')
    expect(fs.readdirSync(objects)).toEqual([`${a.definition.id}.json`])
    expect(readObjectDefinitions(dir, LIMITS).definitions).toEqual([
      { ...a.definition, name: 'Pipe' },
    ])
  })

  it('refuses a blank name, a missing Object and a damaged file, changing nothing', () => {
    put('aaaa0001', '{ nope')
    expect(renameObjectDefinition(dir, LIMITS, 'aaaa0001', 'X').status).toBe('invalid')
    expect(fs.readFileSync(path.join(objects, 'aaaa0001.json'), 'utf8')).toBe('{ nope')
    expect(renameObjectDefinition(dir, LIMITS, 'bbbb0002', 'X').status).toBe('not-found')
    expect(renameObjectDefinition(dir, LIMITS, 'aaaa0001', ' ').status).toBe('invalid')
  })
})

describe('deleteObjectDefinition', () => {
  it('removes only that file, and the other files stay byte-identical', () => {
    const a = saveObjectDefinition(dir, LIMITS, draft)
    const b = saveObjectDefinition(dir, LIMITS, { ...draft, name: 'Other' })
    if (a.status !== 'ok' || b.status !== 'ok') throw new Error('save refused')
    put('damaged1', '{ nope')
    const keep = (id: string) => fs.readFileSync(path.join(objects, `${id}.json`), 'utf8')
    const bBytes = keep(b.definition.id)

    expect(deleteObjectDefinition(dir, a.definition.id)).toEqual({ status: 'ok' })
    expect(fs.existsSync(path.join(objects, `${a.definition.id}.json`))).toBe(false)
    expect(keep(b.definition.id)).toBe(bBytes)
    expect(fs.readFileSync(path.join(objects, 'damaged1.json'), 'utf8')).toBe('{ nope')
  })

  it('removes a damaged file by its stem, and refuses a missing one or a path', () => {
    put('damaged1', '{ nope')
    expect(deleteObjectDefinition(dir, 'damaged1')).toEqual({ status: 'ok' })
    expect(deleteObjectDefinition(dir, 'damaged1').status).toBe('not-found')
    expect(deleteObjectDefinition(dir, '../groups').status).toBe('invalid')
  })
})
