### Changed

- The content gate now blocks an added code or data file that carries vanilla ROM bytes: a byte list (hex arrays, `$` lists, `\x` strings, hex strings) matching 8 bytes of the ROM (`rom-window`), or an array masked with `null`, `undefined` or `??` whose fixed bytes match the ROM (`rom-mask`) (#1053). It judges only files added in the net diff, runs only where the ROM is present, and says on every run when it did not run. CI has no ROM and keeps its other checks.
