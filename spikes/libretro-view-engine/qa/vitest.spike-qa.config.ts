// The repo's root vitest.config.ts intentionally does NOT include spikes/libretro-view-engine/
// (see its `test.include`, scoped to test/suite/**). spikes/libretro-view-engine/ is throwaway
// and out of scope for the shared config, so this file stays local to
// spikes/libretro-view-engine/qa/ (which this agent owns) rather than editing the shared config.
// Run with: npx vitest run --config spikes/libretro-view-engine/qa/vitest.spike-qa.config.ts
import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['spikes/libretro-view-engine/qa/**/*.test.ts'],
    environment: 'node',
    globalSetup: ['test/suite/support/noRealGh.ts'],
  },
})
