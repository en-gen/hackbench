import type { SpawnSyncReturns } from 'child_process'
import { expect } from 'vitest'

// ENOENT means no gh on PATH, which is the safe outcome these tests guard. A
// timeout kill (ETIMEDOUT, non-null signal) has no output and passes every
// later check vacuously, so it must stay red.
export function expectGhReachedOrAbsent(r: SpawnSyncReturns<string>): void {
  const code = (r.error as NodeJS.ErrnoException | undefined)?.code
  expect(code === undefined || code === 'ENOENT').toBe(true)
  expect(r.signal).toBeNull()
}
