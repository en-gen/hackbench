### Changed

- Layer 2: `buildL2Inputs` requires its `entrances` argument, so a caller that leaves it out is a compile error instead of silently placing Layer 2 at the primary entrance (#1340).
