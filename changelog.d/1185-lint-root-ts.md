### Fixed

- `npm run lint` and `lint:fix` now cover the root `*.ts` files (the four `vitest.*.config.ts`), which the globs skipped (#1185). `lintGate.test.ts` plants an unused variable in a root `.ts` file and asserts the script's root globs fail on it; one machine, ESLint as installed.
