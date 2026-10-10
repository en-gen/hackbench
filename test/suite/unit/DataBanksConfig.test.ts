/**
 * meta/data-banks.json: detect once, a present value wins (#755).
 */
import { describe, it, expect, beforeEach, afterEach } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { createProject } from '../../../src/project/Project'
import { resolveDataBanks } from '../../../src/project/DataBanksConfig'
import type { RomFile } from '../../../src/rom/RomFile'
import { ENTRY, RTL, hi, lo, loaderBytes, productionCart } from '../support/syntheticCart'

let tmp: string
let manifestPath: string
let file: string
const SHA = 'a'.repeat(64)

const baseWith = (bank: number): RomFile =>
  productionCart([RTL], { loader: loaderBytes([lo(ENTRY), hi(ENTRY), bank]) })
const onDisk = (): any => JSON.parse(fs.readFileSync(file, 'utf8'))
const put = (v: unknown): string => {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const text = typeof v === 'string' ? v : JSON.stringify(v)
  fs.writeFileSync(file, text)
  return text
}
const resolve = (rom: RomFile, sha = SHA) => resolveDataBanks(manifestPath, rom, sha)
const why = (r: ReturnType<typeof resolve>): string =>
  (r.objectCode as { notFound: string }).notFound

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-banks-'))
  const romPath = path.join(tmp, 'base.sfc')
  fs.writeFileSync(romPath, Buffer.alloc(0x80000, 0x00))
  manifestPath = createProject({ romPath, name: 'P', directory: path.join(tmp, 'P') }).manifestPath
  file = path.join(path.dirname(manifestPath), 'meta', 'data-banks.json')
})
afterEach(() => fs.rmSync(tmp, { recursive: true, force: true }))

describe('resolveDataBanks', () => {
  it('writes an absent file: pretty-printed, hex as $XX, tagged with the ROM sha', () => {
    expect(resolve(baseWith(0x0d)).objectCode).toEqual({ bank: 0x0d })
    expect(onDisk()).toEqual({ version: 1, rom: SHA, banks: { objectCode: '$0D' } })
    expect(fs.readFileSync(file, 'utf8')).toContain('\n  "banks"')
  })

  it('records the $8D operand of a mirrored ROM', () => {
    resolve(baseWith(0x8d))
    expect(onDisk().banks.objectCode).toBe('$8D')
  })

  it('a hand edit survives a reload and wins over detection', () => {
    resolve(baseWith(0x0d))
    put({ version: 1, rom: SHA, banks: { objectCode: '$2d' } })
    expect(resolve(baseWith(0x0d)).objectCode).toEqual({ bank: 0x2d })
    expect(onDisk().banks.objectCode).toBe('$2d') // untouched, not normalized
  })

  it('writes only the absent entry and keeps unknown keys', () => {
    put({ version: 1, rom: SHA, banks: { other: '$05' } })
    expect(resolve(baseWith(0x0d)).objectCode).toEqual({ bank: 0x0d })
    expect(onDisk().banks).toEqual({ other: '$05', objectCode: '$0D' })
  })

  it('re-detects the whole file when the recorded ROM sha differs', () => {
    put({ version: 1, rom: 'b'.repeat(64), banks: { objectCode: '$2D' } })
    expect(resolve(baseWith(0x8d)).objectCode).toEqual({ bank: 0x8d })
    expect(onDisk()).toEqual({ version: 1, rom: SHA, banks: { objectCode: '$8D' } })
  })

  it('records not found with its reason, and reads it back without re-detecting', () => {
    const r = resolve(productionCart([RTL], { pins: false }))
    expect(why(r)).toMatch(/loader/)
    expect(onDisk().banks.objectCode.notFound).toBe(why(r))
    expect(resolve(baseWith(0x0d)).objectCode).toEqual(r.objectCode) // the recorded verdict stands
  })

  it.each(['$100', '0D', '$G1', '$0', 13, '', null, { notFound: 5 }, {}])(
    'refuses malformed value %j with a reason, never detects, never rewrites',
    bad => {
      const text = put({ version: 1, rom: SHA, banks: { objectCode: bad } })
      expect(why(resolve(baseWith(0x0d)))).toMatch(/data-banks\.json/)
      expect(fs.readFileSync(file, 'utf8')).toBe(text)
    },
  )

  it.each([
    '{ nope',
    '[]',
    '{"version":1,"rom":"x","banks":[]}',
    '{"version":2,"rom":"x","banks":{}}',
  ])('refuses a file that is not a v1 config (%s) and leaves it alone', text => {
    put(text)
    expect(why(resolve(baseWith(0x0d)))).toMatch(/data-banks\.json/)
    expect(fs.readFileSync(file, 'utf8')).toBe(text)
  })
})
