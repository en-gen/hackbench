import * as os from 'os'
import * as path from 'path'
import { configDefaults, defineConfig } from 'vitest/config'
import { vitestWorkers } from './tools/scripts/run-slots.mjs'

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
      'test/suite/gates/**/*.test.ts',
    ],
    // Wall-clock gates run alone through vitest.timing.config.ts (#668); the
    // minutes-long corpus sweeps run through vitest.corpus.config.ts (#653).
    exclude: [...configDefaults.exclude, '**/*.timing.test.ts', '**/*.nightly.test.ts'],
    environment: 'node',
    // Up to HACKBENCH_RUN_SLOTS (3) full runs overlap, so each gets a third of the old half-the-cores share; HACKBENCH_VITEST_WORKERS overrides. Not yet measured (run-lock slots, docs/testing.md).
    maxWorkers: vitestWorkers(os.availableParallelism()),
    globalSetup: ['test/suite/support/noRealGh.ts'],
    coverage: {
      provider: 'v8',
      // lcov is what Codecov ingests; the rest are for reading locally.
      reporter: ['text-summary', 'json-summary', 'html', 'lcov'],
      // The core is both trees; the shells and the reference extension are not measured.
      include: ['src/rom/**/*.ts', 'src/project/**/*.ts'],
      exclude: ['**/*.test.ts', '**/*.d.ts'],
      reportsDirectory: 'coverage',
      // A red run still reports, so Codecov sees the coverage of the run that broke.
      reportOnFailure: true,
    },
  },
})
