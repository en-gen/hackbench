### Fixed

- `npm run lint` and `lint:fix` now cover the root `*.ts` files (the four `vitest*.config.ts`), which the globs skipped (#1185). `lintGate.test.ts` asserts each is linted with no findings and that an unused variable in `vitest.config.ts` content fails, without writing to the repo root; ESLint 10.11.0, Windows, one machine; root globs lint in about 1.3 s.
