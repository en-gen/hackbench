### Changed

- Tests (#1209): every test file that starts a process now sets a 30 s file-level `testTimeout` and `hookTimeout` through `loadTimeout`, and `processTimeoutGate.test.ts` fails for a process-starting file without that line. Four per-test budgets that undercut or lagged measured runs are raised: SpriteReport, romWindowProbe, contentGate and the protocolGate and lintGate cases.
