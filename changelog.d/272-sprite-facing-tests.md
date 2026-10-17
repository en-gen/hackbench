### Added

- Sprite initial facing in the map view (#272): tests that Mario's INIT seed is the loader's start on all 512 vanilla maps, that a facing-Mario INIT gives `$157C` 1, 0 and 0 (left, right, tie) across the boundary and a high-byte carry, and that INIT facing matches the Mesen captures on 2149 of 2162 comparable records (13 known mismatches listed in the test; 62 other-side and 38 no-INIT records set aside). The seed is the loader's value, not the #339 start, pending owner ruling D96. Evidence: vanilla ROM and layers_v5 captures, one machine.
