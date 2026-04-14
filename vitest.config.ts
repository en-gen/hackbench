import { defineConfig } from 'vitest/config'

export default defineConfig({
  test: {
    include: ['test/suite/unit/**/*.test.ts', 'test/suite/integration/**/*.test.ts'],
    environment: 'node',
  },
})
