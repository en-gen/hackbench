### Changed

- Tests (#1209): every test file that starts a process now carries a load-scaled `testTimeout` and `hookTimeout` (30 s, 60 s floor in CI), enforced by `processTimeoutGate.test.ts`, so spawn-heavy files stop timing out at 5 s on a busy machine.
