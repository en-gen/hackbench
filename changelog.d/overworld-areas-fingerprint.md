### Changed

- Overworld areas: the area-list code recognizes the game's routines by SHA-256 fingerprints (operands masked) instead of committed byte patterns, so no cart bytes sit in the source. The warp, path and destination routines are now found where their callers call, so a hack that moves one and retargets the call still resolves. Evidence: the full derived result (every area and camera position, every hack's refusal text) hashes identically before and after on all 6 corpus ROMs, one machine; planted one-byte changes in each routine and caller refuse on synthetic carts.
