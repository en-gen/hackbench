### Changed

- The synthetic sprite cart holds no vanilla byte window in any variant (#1073): the two allow-listed regions are gone, the allow list is held at empty by a test that needs no ROM, and the variant list now covers every option that changes bytes. Test and fixture only; vitest with the vanilla ROM, one machine, 2026-11-05.
