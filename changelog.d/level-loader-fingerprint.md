### Changed

- Sprite and collision previews: the level loader now recognises eight of the game's loader routines by a SHA-256 fingerprint instead of a copy of their bytes, so the repository no longer holds ROM code slices there. Nothing changes on the vanilla ROM: the loader output for all 512 level numbers (steps and the full work RAM image) hashes identically before and after, one machine, 2026-10-17. A ROM whose routine differs is still refused with the same plain-words reason naming the routine; a test per routine changes one byte and expects that refusal.

Merging with #1050: whichever lands second converts #1050's 9FB8 (8 B) and A5AF (23 B) shapes to `LOADER_SPANS` entries, hand-writes their synthetic stand-ins, adds their `STAND_IN_LENGTH` entries in `test/suite/support/syntheticLoaderSpans.ts`, ports its loader tails, and re-pins `VANILLA_ALL_LEVELS` and PTR/ENT.
