import * as path from 'path'
import { defineConfig } from 'vitest/config'

// Hack-corpus sweeps (#653): minutes each, so they leave `test:unit` and run
// here, from the nightly. Restated rather than merged: mergeConfig
// concatenates `include`. One file at a time; each sweep is CPU-bound.
export default defineConfig({
  resolve: {
    alias: { vscode: path.resolve(__dirname, 'test/suite/support/vscodeStub.ts') },
  },
  test: {
    include: ['test/suite/**/*.nightly.test.ts'],
    environment: 'node',
    globalSetup: ['test/suite/support/noRealGh.ts'],
    fileParallelism: false,
  },
})
