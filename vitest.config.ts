import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/suite/unit/**/*.test.ts', 'test/suite/integration/**/*.test.ts'],
    environment: 'node',
    coverage: {
      provider: 'v8',
      reporter: ['text-summary', 'json-summary', 'html'],
      include: ['src/rom/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reportsDirectory: 'coverage',
    },
  },
})
