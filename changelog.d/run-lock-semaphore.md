### Changed

- Run lock: a counting semaphore of 3 lock slots instead of one lock, so up to 3 teams run full tests, builds or Playwright at once. One lock slot per team. Playwright picks free ports itself (`HB_PORT` forces one); vitest workers are capped to a third of the old share (`HACKBENCH_RUN_SLOTS`, `HACKBENCH_VITEST_WORKERS`). See docs/testing.md, Run lock.
