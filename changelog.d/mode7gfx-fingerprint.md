### Changed

- The Mode 7 graphics reader recognizes the game's unpack routine by one SHA-256 fingerprint over the whole routine instead of storing its code bytes. The bit-shifting helper is now checked by running it, and the call site by its structure. On the stock ROM and the five hacks the result is unchanged; a hack that edits the unpack routine itself is no longer claimed as unavailable and is read as ordinary graphics.
