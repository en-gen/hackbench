### Fixed

- Tests (#892): changelogCombine's git helper ignores the machine's global and system git config and hooks; a global post-checkout hook made its two real-git merge tests pass vitest's 5 s timeout under parallel load (10 of 60 loaded runs, one machine; 0 of 60 with the config isolated). No retries or timeout change.
