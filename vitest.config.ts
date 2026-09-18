import * as path from 'path'
import { defineConfig } from 'vitest/config'

export default defineConfig({
  resolve: {
    // `vscode` only resolves inside an extension host. The tree providers need
    // six symbols from it; test/suite/support/vscodeStub.ts supplies exactly
    // those, so provider tests run in the same process as everything else.
    alias: { vscode: path.resolve(__dirname, 'test/suite/support/vscodeStub.ts') },
  },
  test: {
    include: [
      'test/suite/unit/**/*.test.ts',
      'test/suite/integration/**/*.test.ts',
      'test/suite/provider/**/*.test.ts',
    ],
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
