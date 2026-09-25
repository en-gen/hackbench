/**
 * The meta/ store: one JSON file per concern, atomic writes, no silent
 * overwrite of a file that already exists but is not valid JSON.
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createProject } from '../../../src/project/Project'
import { readMeta, writeMeta, META_DIR } from '../../../src/project/ProjectMeta'

let tmp: string
let manifestPath: string
let metaDir: string

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-meta-'))
  const romPath = path.join(tmp, 'base.sfc')
  fs.writeFileSync(romPath, Buffer.alloc(0x80000, 0x00))
  manifestPath = createProject({
    romPath,
    name: 'MyHack',
    directory: path.join(tmp, 'MyHack'),
  }).manifestPath
  metaDir = path.join(path.dirname(manifestPath), META_DIR)
})
afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true })
})

describe('readMeta', () => {
  it('reads undefined for a concern that has never been written', () => {
    expect(readMeta(manifestPath, 'aliases')).toBeUndefined()
  })

  it('reads back what writeMeta wrote', () => {
    writeMeta(manifestPath, 'aliases', { map: { '105': 'Sky bridge' } })
    expect(readMeta(manifestPath, 'aliases')).toEqual({ map: { '105': 'Sky bridge' } })
  })

  it('throws on invalid JSON and leaves the file untouched', () => {
    fs.mkdirSync(metaDir, { recursive: true })
    const file = path.join(metaDir, 'aliases.json')
    fs.writeFileSync(file, '{ not json')

    expect(() => readMeta(manifestPath, 'aliases')).toThrow(/aliases\.json/)
    expect(fs.readFileSync(file, 'utf8')).toBe('{ not json')
  })

  it('refuses a manifest openProject rejects, before touching meta/', () => {
    const missing = path.join(tmp, 'nope', 'Nope.hbproj')
    expect(() => readMeta(missing, 'aliases')).toThrow()
  })
})

describe('writeMeta', () => {
  it('creates meta/ on first write', () => {
    expect(fs.existsSync(metaDir)).toBe(false)
    writeMeta(manifestPath, 'groups', { a: 1 })
    expect(fs.existsSync(path.join(metaDir, 'groups.json'))).toBe(true)
  })

  it('writes pretty JSON with a trailing newline', () => {
    writeMeta(manifestPath, 'aliases', { a: 1 })
    const raw = fs.readFileSync(path.join(metaDir, 'aliases.json'), 'utf8')
    expect(raw).toBe(`${JSON.stringify({ a: 1 }, null, 2)}\n`)
  })

  it('leaves no .tmp file behind', () => {
    writeMeta(manifestPath, 'aliases', { a: 1 })
    expect(fs.readdirSync(metaDir)).toEqual(['aliases.json'])
  })

  it('refuses a manifest openProject rejects, before creating meta/', () => {
    const missing = path.join(tmp, 'nope', 'Nope.hbproj')
    expect(() => writeMeta(missing, 'aliases', { a: 1 })).toThrow()
    expect(fs.existsSync(path.join(tmp, 'nope'))).toBe(false)
  })
})
