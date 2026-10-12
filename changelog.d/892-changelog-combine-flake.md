### Fixed

- Tests (#892): changelogCombine's git helper ignores the machine's global and system git config and hooks, and its merge tests get a 30 s timeout. A global post-checkout hook made its two real-git merge tests exceed vitest's 5 s timeout under parallel load (10 of 60 loaded runs, one machine; 0 of 60 with the config isolated, then 1 of 24 under heavier process-spawn load, test not captured).
