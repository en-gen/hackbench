import { defineConfig } from 'vitest/config'

// Separate from vitest.config.ts on purpose: test:unit's include list never
// mentions test/perf, and this file's include list never mentions
// test/suite, so neither command can accidentally pick up the other's cases.
export default defineConfig({
  test: {
    include: ['test/perf/core/**/*.bench.ts'],
    environment: 'node',
    globalSetup: ['test/suite/support/noRealGh.ts'],
    // 10 minutes (design D4): a catastrophic regression must show up as a
    // slow, honest measurement the detector can flag, not as a vitest
    // timeout error that gets swallowed as "the suite failed" instead.
    testTimeout: 600000,
    fileParallelism: false,
  },
})
