### Changed

- Theia builds and Playwright runs (#1038): refused with a plain message when `theia/node_modules` is a junction to another checkout or its workspace links point there, since that bundles the other checkout's extension and shares its build cache. Evidence: synthetic-layout unit tests, one Windows machine.
