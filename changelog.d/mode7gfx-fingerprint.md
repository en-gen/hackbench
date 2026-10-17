### Changed

- The Mode 7 graphics reader recognizes the game's unpack routine, helper and call site by SHA-256 fingerprint instead of storing their code bytes. Behavior on the stock ROM and on the hacks is unchanged; changed code is still refused (the file is reported unavailable, as before).
