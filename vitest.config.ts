import * as os from 'os'
import * as path from 'path'
import { configDefaults, defineConfig } from 'vitest/config'

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
    // Wall-clock gates run alone through vitest.timing.config.ts (#668).
    exclude: [...configDefaults.exclude, '**/*.timing.test.ts'],
    environment: 'node',
    // Two concurrent full runs at the default (about one worker per core) oversubscribe the CPU; 9 of 10 runs green at the default in 5 paired samples, 32-core machine, 2026-10-10. Floor 2 keeps a 2-core CI runner at 2.
    maxWorkers: Math.max(2, Math.floor(os.availableParallelism() / 2)),
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
