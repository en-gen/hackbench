### Changed

- Run lock: a counting semaphore of 3 slots instead of one lock, so up to 3 teams run full tests, builds or Playwright at once. One slot per team; slot N uses port 2999+N through `HB_PORT`; vitest workers are capped to a third of the old share (`HACKBENCH_RUN_SLOTS`, `HACKBENCH_VITEST_WORKERS`). See docs/testing.md, Run lock.
