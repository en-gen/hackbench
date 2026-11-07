### Fixed

- Sprite Properties (#1113): a sprite whose every pass draws characters that are not loaded, or whose first (map) pass does and at most one later pose draws, now says "Animation not shown: Some of its graphics are not loaded on this map." instead of "Not animated: this sprite shows one pose." Synthetic unit tests, no ROM.
