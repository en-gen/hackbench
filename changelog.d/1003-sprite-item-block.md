### Changed

- Tests: a synthetic, ROM-free case proves a sprite pixel over an item block is never covered by the block's indicator (#1003). It builds the block and the sprite pixel in the test and runs the real indicator placement, plane order and compose; evidence: 3 cases (low-priority block under sprite priority 2 and 3, high-priority block under 3), one machine. Planting "every Layer 1 indicator goes to the high plane" turns 2 of the 3 red.
