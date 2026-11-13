/**
 * The stand-in reader for #1236's object definition files: the rules the finder relies on.
 * Replaced with the real reader's tests when #1236 merges.
 */
import { afterEach, describe, expect, it } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import {
  objectsDir,
  readObjectDefinitions,
  type ObjectDefinitionLimits,
} from '../../../src/project/ObjectDefinitionsStandIn'

const LIMITS: ObjectDefinitionLimits = { tilesetCount: 15, tileCount: 512 }
const roots: string[] = []
function project(files: Record<string, unknown>): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-objdefs-'))
  roots.push(root)
  const manifest = path.join(root, 'p.hbproj')
  fs.mkdirSync(objectsDir(manifest), { recursive: true })
  for (const [name, body] of Object.entries(files))
    fs.writeFileSync(path.join(objectsDir(manifest), name), typeof body === 'string' ? body : JSON.stringify(body)) // prettier-ignore
  return manifest
}
afterEach(() => {
  for (const r of roots.splice(0)) fs.rmSync(r, { recursive: true, force: true })
})
const good = (id: string, over: Record<string, unknown> = {}) => ({ version: 1, id, name: 'Ground', tileset: 1, edge: [256, 257], fill: [258], ...over }) // prettier-ignore

describe('readObjectDefinitions (stand-in)', () => {
  it('a missing folder is no definitions, not an error', () => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-objdefs-'))
    roots.push(root)
    expect(readObjectDefinitions(path.join(root, 'p.hbproj'), LIMITS)).toEqual({ definitions: [], skipped: [] }) // prettier-ignore
  })

  it('loads a valid file, treats the lists as sets and ignores unknown fields', () => {
    const m = project({ 'a1.json': good('a1', { edge: [257, 256, 256], facing: 'later' }) })
    const r = readObjectDefinitions(m, LIMITS)
    expect(r.skipped).toEqual([])
    expect(r.definitions).toEqual([{ id: 'a1', name: 'Ground', tileset: 1, edge: [257, 256], fill: [258] }]) // prettier-ignore
  })

  const bad: [string, string | Record<string, unknown>, RegExp][] = [
    ['not JSON', '{nope', /not readable JSON/],
    ['an array', '[1]', /not a JSON object/],
    ['a newer version', good('x', { version: 2 }), /newer HackBench/],
    ['no version', { ...good('x'), version: undefined }, /version/],
    ['id differing from the file name', good('other'), /differs from its file name/],
    ['a blank name', good('x', { name: '  ' }), /name/],
    ['a non-integer tile', good('x', { edge: [1.5] }), /whole number/],
    ['a tile in both lists', good('x', { edge: [5], fill: [5] }), /both an edge and a fill/],
    ['a tile past the count', good('x', { fill: [512] }), /outside/],
    ['a negative tile', good('x', { fill: [-1] }), /outside/],
    ['a tileset past the last', good('x', { tileset: 15 }), /tileset/],
  ]
  for (const [what, body, why] of bad) {
    it(`skips a file with ${what}, with a plain reason, and still loads the others`, () => {
      const m = project({ 'x.json': body, 'ok.json': good('ok') })
      const r = readObjectDefinitions(m, LIMITS)
      expect(r.definitions.map(d => d.id)).toEqual(['ok'])
      expect(r.skipped).toEqual([{ file: 'x.json', reason: expect.stringMatching(why) }])
    })
  }

  it('skips a file larger than 64 KiB', () => {
    const m = project({ 'big.json': ' '.repeat(65 * 1024) })
    expect(readObjectDefinitions(m, LIMITS).skipped[0]!.reason).toMatch(/64 KiB/)
  })

  it('skips every file, with the reason, when the ROM tile count is unreadable', () => {
    const m = project({ 'a.json': good('a') })
    const r = readObjectDefinitions(m, { tilesetCount: 15, tileCount: null, tileCountReason: 'Map16 is expanded.' }) // prettier-ignore
    expect(r.definitions).toEqual([])
    expect(r.skipped).toEqual([{ file: 'a.json', reason: 'Map16 is expanded.' }])
  })

  it('ignores temp files, other extensions and subfolders', () => {
    const m = project({ 'a.json': good('a'), 'a.json.123.tmp': 'junk', 'notes.txt': 'x' })
    fs.mkdirSync(path.join(objectsDir(m), 'sub.json'))
    const r = readObjectDefinitions(m, LIMITS)
    expect(r.definitions.map(d => d.id)).toEqual(['a'])
    expect(r.skipped).toEqual([])
  })

  it('never writes: the files are byte-identical after a read, damaged ones included', () => {
    const m = project({ 'bad.json': '{nope', 'a.json': good('a') })
    const before = fs.readdirSync(objectsDir(m)).map(f => fs.readFileSync(path.join(objectsDir(m), f), 'utf8')) // prettier-ignore
    readObjectDefinitions(m, LIMITS)
    const after = fs.readdirSync(objectsDir(m)).map(f => fs.readFileSync(path.join(objectsDir(m), f), 'utf8')) // prettier-ignore
    expect(after).toEqual(before)
  })
})
