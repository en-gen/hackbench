### Changed

- Test-only (#1368): the Info Box ($B9) on map $004 graded wrong because the old capture recorded a Boo ring tile (OAM 126) as its second piece, a cluster index equal to its sprite slot (`hackbench-validation` 48d348c fixed the recorder). Map 004 re-captured with bc8d1a3 grades exact; with it, graded 1955, exact 1926, close 17, wrong 12, empty 0 (vanilla ROM, one machine, 2026-11-13). A new test pins the row and floors follow. No behaviour change.
