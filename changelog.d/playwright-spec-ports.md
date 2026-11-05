### Fixed

- Playwright: 13 specs defaulted to port 3000 instead of the port the config picks, so they were refused a connection whenever the server was elsewhere (122 of 653 tests on gh01's first full run, 2026-11-05). They now read `HB_PORT`, and a gate fails any spec that hard-codes a port.
