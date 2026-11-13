### Changed

- Tests: the sprite grader counts a level-start sprite's passes from the capture's first GM14 frame (`gateFrame`) instead of the anchor, so maps 0C3 ($49 growing pipe), 130 ($76 star) and 0D0 ($6F) grade exact at the pass the capture recorded and no longer miss at k (#875). GM13 runs no sprite code (SMWDisX bank_00.asm:4075-4103); the pass-0 offset at the gate is not traced, and Tier 2 uses the same pass. Evidence: vanilla, one machine, 1955 records; synthetic ROM-free cases cover the pass for level-start, spawned-in-play and drawn-before-gate records.
