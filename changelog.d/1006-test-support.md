### Changed

- Tests: the five scroll-simulator capture tests, four synthetic music upload tests and three synthetic ROM builders now import their capture loader, upload routine and little-endian builders from shared test support instead of carrying copies (#1006). Test code only; assertions and registered test counts unchanged.
