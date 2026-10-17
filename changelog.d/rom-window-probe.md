### Added

- Report-only ROM-window probe, `tools/scripts/rom-window-probe.mjs`: lists runs of 8 bytes in text, a diff's added lines or assembled bytes that also occur in the vanilla ROM, so a synthetic fixture can be checked before pushing. Not a gate: nothing runs it. Evidence: unit tests on a PRNG fake ROM (planted copy red, 7-byte copy and low-variety window green, copier header stripped, exit codes, SKIP without a ROM); the filter, header strip and ROM lookup each shown to turn a test red when broken.
