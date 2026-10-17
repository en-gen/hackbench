### Added

- Sprite initial facing in the map view (#272): tests that Mario's INIT seed is the loader's start on all 512 vanilla maps, that a facing-Mario INIT gives `$157C` 1, 0 and 0 (left, right, tie), and that INIT facing matches the Mesen captures on 2014 of 2026 comparable records (12 known mismatches listed in the test, 236 records excluded because the capture's Mario at INIT differs). Evidence: vanilla ROM and layers_v5 captures, one machine.
