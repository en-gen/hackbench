/**
 * The harness overlay (design D1) must leave the base checkout exactly as it
 * was when copying the candidate's harness fails partway.
 */
import { describe, it, expect, vi, afterEach } from 'vitest'
import * as realFs from 'node:fs'
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

let failCopyFrom: string | undefined
vi.mock('node:fs', async importOriginal => {
  const fs = await importOriginal<typeof realFs>()
  return {
    ...fs,
    cpSync: (src: string, dst: string, opts?: realFs.CopySyncOptions) => {
      if (failCopyFrom && String(src).startsWith(failCopyFrom))
        throw new Error('planted copy failure')
      return fs.cpSync(src, dst, opts)
    },
  }
})

const { overlayHarness } = await import('../../../tools/perf/paired.mjs')

function checkout(root: string, marker: string) {
  mkdirSync(join(root, 'test', 'perf'), { recursive: true })
  writeFileSync(join(root, 'test', 'perf', 'case.ts'), marker)
  writeFileSync(join(root, 'vitest.perf.config.ts'), marker)
}

describe('overlayHarness: failure recovery', () => {
  let tmp: string
  afterEach(() => {
    failCopyFrom = undefined
    rmSync(tmp, { recursive: true, force: true })
  })

  it('restores the base when copying the candidate harness throws', () => {
    tmp = mkdtempSync(join(tmpdir(), 'hb-overlay-test-'))
    const base = join(tmp, 'base')
    const cand = join(tmp, 'cand')
    checkout(base, 'base')
    checkout(cand, 'cand')
    failCopyFrom = cand
    expect(() => overlayHarness(base, cand)).toThrow(/planted copy failure/)
    expect(readFileSync(join(base, 'test', 'perf', 'case.ts'), 'utf8')).toBe('base')
    expect(readFileSync(join(base, 'vitest.perf.config.ts'), 'utf8')).toBe('base')
  })

  it('overlays and then restores on the happy path', () => {
    tmp = mkdtempSync(join(tmpdir(), 'hb-overlay-test-'))
    const base = join(tmp, 'base')
    const cand = join(tmp, 'cand')
    checkout(base, 'base')
    checkout(cand, 'cand')
    const restore = overlayHarness(base, cand)
    expect(readFileSync(join(base, 'vitest.perf.config.ts'), 'utf8')).toBe('cand')
    restore()
    expect(readFileSync(join(base, 'vitest.perf.config.ts'), 'utf8')).toBe('base')
    expect(existsSync(join(base, 'test', 'perf', 'case.ts'))).toBe(true)
  })
})
