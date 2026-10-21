### Changed

- The content-gate develop-clean test reads files in parallel and runs only the rom-provenance rule; one machine, the case took about 2.3 s under load before and is measured after in #485.
