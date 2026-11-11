### Changed

- Test-only (#839, #1370): the sprite grader's floors follow four re-captured level-load captures (maps 101, 1d4, 109, 11b, harness `hackbench-validation` `bc8d1a3`): 1955 graded records, exact 1925, close 17, wrong 13, empty 0 (was 1957, 1917, 17, 22, 1; vanilla ROM, one machine, 2026-11-11). Nine records on maps 101 and 1d4 went from wrong to exact because the old harness attributed a castle-flame cluster tile (OAM 124-126) to those sprites. No behaviour change.
