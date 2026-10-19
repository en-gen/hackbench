// Slot count and derived limits shared by run-lock.mjs and vitest.config.ts,
// so the lock and the worker cap can never disagree about how many runs overlap.

export const DEFAULT_SLOTS = 3

const positiveInt = v => (typeof v === 'string' && /^[1-9]\d*$/.test(v) ? Number(v) : undefined)

// An invalid value falls back rather than throwing: a typo must not wedge the lock.
export const slotCount = (env = process.env) =>
  positiveInt(env.HACKBENCH_RUN_SLOTS) ?? DEFAULT_SLOTS

// Each full run may be one of `slots` at once, so each gets its share of the
// half of the cores vitest was already allowed. An explicit override wins.
// CI runs one job per machine, so it keeps the old formula and its floor of 2.
export function vitestWorkers(cpus, env = process.env) {
  const override = positiveInt(env.HACKBENCH_VITEST_WORKERS)
  if (override) return override
  if (env.CI) return Math.max(2, Math.floor(cpus / 2))
  return Math.max(1, Math.floor(cpus / 2 / slotCount(env)))
}
