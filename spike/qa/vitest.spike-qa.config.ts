// The repo's root vitest.config.ts intentionally does NOT include spike/
// (see its `test.include`, scoped to test/suite/**). spike/ is throwaway
// and out of scope for the shared config, so this file stays local to
// spike/qa/ (which this agent owns) rather than editing the shared config.
// Run with: npx vitest run --config spike/qa/vitest.spike-qa.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['spike/qa/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/suite/support/noRealGh.ts'],
  },
})
