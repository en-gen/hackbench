### Changed

- Tests (#653): the hack-corpus leaf sweep (about ten minutes: 546 s for its six tests in one run, one machine, run lock held, 2026-10-10) leaves `npm run test:unit` for `npm run test:corpus` (`*.nightly.test.ts`, `vitest.corpus.config.ts`); the synthetic grouping tests stay in `test:unit`. No opt-in variable: each corpus case runs when both its ROM and the vanilla ROM are present and skips otherwise.
