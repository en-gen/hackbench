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
  write: undefined as
    undefined | ((fd: number, buf: Uint8Array, off: number, len: number) => number),
}))
vi.mock('fs', async importOriginal => {
  const real = await importOriginal<typeof import('fs')>()
  const wrapped = {
    ...real,
    renameSync: (a: string, b: string) => {
      hooks.renameCalls++
      return hooks.rename ? hooks.rename() : real.renameSync(a, b)
    },
    writeSync: (fd: number, buf: Uint8Array, off: number, len: number) =>
      hooks.write ? hooks.write(fd, buf, off, len) : real.writeSync(fd, buf, off, len),
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
  hooks.write = undefined
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

  it('writes every byte when each write call takes only part of the buffer', () => {
    const file = path.join(dir, 'd.bin')
    const input = Uint8Array.from({ length: 100 }, (_, i) => i)
    let calls = 0
    const hook = (fd: number, buf: Uint8Array, off: number, len: number) => {
      calls++
      const start = off ?? 0
      hooks.write = undefined // call through to the real write, then re-arm
      try {
        return fs.writeSync(fd, buf, start, Math.min(len ?? buf.length - start, 7))
      } finally {
        hooks.write = hook
      }
    }
    hooks.write = hook
    writeFileAtomic(file, input)
    expect(calls).toBeGreaterThan(1)
    expect([...fs.readFileSync(file)]).toEqual([...input])
  })

  it('throws, removes the temp and keeps the old file when a write takes zero bytes', () => {
    const file = path.join(dir, 'e.bin')
    fs.writeFileSync(file, 'old')
    // Returns 0 once, then throws: a loop that ignores the zero return fails here
    // instead of spinning forever (a sync loop also blocks vitest's own timeout).
    let calls = 0
    hooks.write = () => {
      if (calls++ > 0) throw new Error('write hook called again after a zero-byte return')
      return 0
    }
    expect(() => writeFileAtomic(file, 'new content')).toThrow(/Short write.*e\.bin/)
    expect(fs.readdirSync(dir)).toEqual(['e.bin'])
    expect(fs.readFileSync(file, 'utf8')).toBe('old')
  })

  it('a refused wx open deletes nothing: a planted file at the temp path survives with its content', () => {
    const file = path.join(dir, 'f.json')
    fs.writeFileSync(file, 'old')
    const tmp = `${file}.${process.pid}.tmp`
    fs.writeFileSync(tmp, 'another writer live temp')
    expect(() => writeFileAtomic(file, 'new')).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    expect(fs.readFileSync(tmp, 'utf8')).toBe('another writer live temp')
    expect(fs.readFileSync(file, 'utf8')).toBe('old')
  })

  it('a directory at the temp path surfaces EEXIST, not the cleanup error, and survives', () => {
    const file = path.join(dir, 'g.json')
    const tmp = `${file}.${process.pid}.tmp`
    fs.mkdirSync(tmp)
    expect(() => writeFileAtomic(file, 'new')).toThrow(expect.objectContaining({ code: 'EEXIST' }))
    expect(fs.statSync(tmp).isDirectory()).toBe(true)
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
