import { defineConfig } from 'vitest/config'

// Separate from vitest.config.ts on purpose: test:unit's include list never
// mentions test/perf, and this file's include list never mentions
// test/suite, so neither command can accidentally pick up the other's cases.
export default defineConfig({
  test: {
    include: ['test/perf/core/**/*.bench.ts'],
    environment: 'node',
    testTimeout: 30000,
    fileParallelism: false,
  },
})
