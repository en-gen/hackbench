### Changed

- Sprite and collision previews: the level loader no longer holds a copy of the game's loader code or a fingerprint of it. It checks a handful of single instructions (the calls and the jump it follows, by their targets, and the opening instruction of each entry) and then runs the ROM's own routines on the 65816 core. Nothing changes on the vanilla ROM: the loader output for all 512 level numbers (steps and the full work RAM image) hashes identically before and after, one machine, 2026-10-18.
- Acceptance, measured over the 146 store hacks, one machine, 2026-10-18: the loader accepts exactly the 22 hacks the old loader accepted, and each loads or is refused while running as before (17 load level `$105`, 5 are refused while running with a reason; the other 124 are refused by shape). A ROM whose checked instruction differs is still refused with a plain-words reason naming the routine.

Merging with #1050: whichever lands second converts #1050's 9FB8 (8 B) and A5AF (23 B) shapes to `LOADER_SITES` entries (single instructions) or to a run of the routine, hand-writes the matching synthetic stand-in bytes, ports its loader tails, and re-pins `VANILLA_ALL_LEVELS` and PTR/ENT.
