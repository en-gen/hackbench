import * as path from 'path'
import { defineConfig } from 'vitest/config'

// The wall-clock gates (#668, #537). They flake when another test file runs
// beside them, so they leave `test:unit` and run alone, one file at a time.
// Restated rather than merged: mergeConfig concatenates `include`.
export default defineConfig({
  resolve: {
    alias: { vscode: path.resolve(__dirname, 'test/suite/support/vscodeStub.ts') },
  },
  test: {
    include: ['test/suite/**/*.timing.test.ts'],
    environment: 'node',
    globalSetup: ['test/suite/support/noRealGh.ts'],
    fileParallelism: false,
  },
})
