// A per-test timeout replaces the CLI --testTimeout, so a measured 10 s would
// LOWER CI's 60 s budget (ci.yml) on a 2-core runner. vitest 5 has no
// vi.getConfig, so the floor mirrors the workflow value under process.env.CI.
const CI_FLOOR_MS = 60_000
export const loadTimeout = (ms: number): number => (process.env.CI ? Math.max(ms, CI_FLOOR_MS) : ms)

// The options-argument form: unlike a trailing number, it keeps the callback
// body's indentation when Prettier rewraps a long test title.
export const slow = (ms: number): { timeout: number } => ({ timeout: loadTimeout(ms) })
