### Changed

- Tests (#653): the ten-minute hack-corpus leaf sweep leaves `npm run test:unit` for `npm run test:corpus` (`*.nightly.test.ts`, `vitest.corpus.config.ts`); the synthetic grouping tests stay in `test:unit`. No opt-in variable: the sweep runs whenever the ROMs are present.
