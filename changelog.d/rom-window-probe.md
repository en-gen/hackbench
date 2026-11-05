### Added

- Report-only ROM-window probe, `tools/scripts/rom-window-probe.mjs`: lists 8-byte windows in text, a diff's added lines or assembled bytes that also occur in the vanilla ROM, so a synthetic fixture can be checked before pushing. Not a gate: nothing runs it. Evidence: unit tests on a PRNG fake ROM, including a sweep over 3 to 8 distinct values and nine text forms (a smoke test, not coverage evidence).
