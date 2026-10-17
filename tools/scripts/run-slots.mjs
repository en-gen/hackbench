// Slot count and derived limits shared by run-lock.mjs and vitest.config.ts,
// so the lock and the worker cap can never disagree about how many runs overlap.

export const DEFAULT_SLOTS = 3
export const BASE_PORT = 3000

const positiveInt = v => (typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Number(v) : undefined)

// An invalid value falls back rather than throwing: a typo must not wedge the lock.
export const slotCount = (env = process.env) =>
  positiveInt(env.HACKBENCH_RUN_SLOTS) ?? DEFAULT_SLOTS

// Slot 1 keeps 3000 so a lone run behaves as before the semaphore.
export const slotPort = slot => BASE_PORT - 1 + slot

// Each full run may be one of `slots` at once, so each gets its share of the
// half of the cores vitest was already allowed. An explicit override wins.
export function vitestWorkers(cpus, env = process.env) {
  return (
    positiveInt(env.HACKBENCH_VITEST_WORKERS) ?? Math.max(1, Math.floor(cpus / 2 / slotCount(env)))
  )
}
