import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import * as fs from 'fs'
import * as os from 'os'
import * as path from 'path'
import { renameWithRetry, writeFileAtomic } from '../../../src/project/atomicWrite'

// ESM namespaces cannot be spied on, so the module's fs is wrapped once and
// the wrappers delegate unless a test sets a hook.
const hooks = vi.hoisted(() => ({
  rename: undefined as undefined | (() => void),
  renameCalls: 0,
  opened: [] as string[],
}))
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>()
  const wrapped = {
    ...real,
    renameSync: (a: string, b: string) => {
      hooks.renameCalls++
      return hooks.rename ? hooks.rename() : real.renameSync(a, b)
    },
    openSync: (f: string, flags: string) => {
      hooks.opened.push(`${f}|${flags}`)
      return real.openSync(f, flags)
    },
  }
  return { ...wrapped, default: wrapped }
})

let dir: string
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'hb-atomic-'))
})
afterEach(() => {
  hooks.rename = undefined
  hooks.renameCalls = 0
  hooks.opened.length = 0
  fs.rmSync(dir, { recursive: true, force: true })
})

describe('writeFileAtomic', () => {
  it('leaves the whole new content, for bytes and for text, replacing an old file', () => {
    const file = path.join(dir, 'a.bin')
    fs.writeFileSync(file, 'old and longer than the new one')
    writeFileAtomic(file, Uint8Array.from([1, 2, 3]))
    expect([...fs.readFileSync(file)]).toEqual([1, 2, 3])
    writeFileAtomic(file, 'text\n')
    expect(fs.readFileSync(file, 'utf8')).toBe('text\n')
    expect(fs.readdirSync(dir)).toEqual(['a.bin'])
  })

  it('names the temp file with the pid, in the same directory', () => {
    const file = path.join(dir, 'b.json')
    writeFileAtomic(file, 'x')
    expect(hooks.opened).toContain(`${file}.${process.pid}.tmp|wx`)
  })

  it('removes the temp file, keeps the old one and rethrows when the rename fails', () => {
    const file = path.join(dir, 'c.json')
    fs.writeFileSync(file, 'old')
    const boom = Object.assign(new Error('injected'), { code: 'EIO' })
    hooks.rename = () => {
      throw boom
    }
    expect(() => writeFileAtomic(file, 'new')).toThrow(boom)
    expect(fs.readdirSync(dir)).toEqual(['c.json'])
    expect(fs.readFileSync(file, 'utf8')).toBe('old')
  })
})

describe('renameWithRetry', () => {
  it('survives an EPERM on the first two attempts', () => {
    const from = path.join(dir, 'from')
    const to = path.join(dir, 'to')
    fs.writeFileSync(from, 'x')
    hooks.rename = () => {
      if (hooks.renameCalls <= 2) throw Object.assign(new Error('busy'), { code: 'EPERM' })
      hooks.rename = undefined
      hooks.renameCalls-- // the real call below goes through the counting wrapper too
      fs.renameSync(from, to)
    }
    renameWithRetry(from, to)
    expect(hooks.renameCalls).toBe(3)
    expect(fs.readFileSync(to, 'utf8')).toBe('x')
  })

  it('rethrows any other error at once, without a retry', () => {
    hooks.rename = () => {
      throw Object.assign(new Error('io'), { code: 'EIO' })
    }
    expect(() => renameWithRetry('a', 'b')).toThrow('io')
    expect(hooks.renameCalls).toBe(1)
  })
})
