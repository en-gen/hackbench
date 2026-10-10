import type { SpawnSyncReturns } from 'child_process'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { expectGhReachedOrAbsent } from '../support/ghSpawnReached'
import { loadTimeout } from '../support/loadTimeout'

// Synthetic, no ROM. These prove the two support helpers can go red.
const spawned = (
  error: { code: string } | undefined,
  signal: NodeJS.Signals | null,
): SpawnSyncReturns<string> =>
  ({
    error,
    signal,
    status: null,
    output: [],
    pid: 0,
    stdout: '',
    stderr: '',
  }) as unknown as SpawnSyncReturns<string>

describe('expectGhReachedOrAbsent', () => {
  it('throws on a timeout kill (ETIMEDOUT with SIGTERM)', () => {
    expect(() => expectGhReachedOrAbsent(spawned({ code: 'ETIMEDOUT' }, 'SIGTERM'))).toThrow()
  })
  it('throws on a signal with no error', () => {
    expect(() => expectGhReachedOrAbsent(spawned(undefined, 'SIGTERM'))).toThrow()
  })
  it('throws on another error code', () => {
    expect(() => expectGhReachedOrAbsent(spawned({ code: 'EACCES' }, null))).toThrow()
  })
  it('passes on ENOENT (no gh on PATH)', () => {
    expect(() => expectGhReachedOrAbsent(spawned({ code: 'ENOENT' }, null))).not.toThrow()
  })
  it('passes on a clean reached result', () => {
    expect(() => expectGhReachedOrAbsent(spawned(undefined, null))).not.toThrow()
  })
})

describe('loadTimeout', () => {
  afterEach(() => vi.unstubAllEnvs())
  it('raises a short timeout to the 60 s CI floor when CI is set', () => {
    vi.stubEnv('CI', 'true')
    expect(loadTimeout(10_000)).toBe(60_000)
  })
  it('keeps a timeout above the floor when CI is set', () => {
    vi.stubEnv('CI', 'true')
    expect(loadTimeout(120_000)).toBe(120_000)
  })
  it('is the identity when CI is empty', () => {
    vi.stubEnv('CI', '')
    expect(loadTimeout(10_000)).toBe(10_000)
  })
})
