### Changed

- The content gate now blocks an added code or data file whose byte lists (hex arrays, `$` lists, `\x` strings, hex strings) match 8 bytes of the vanilla ROM, as a copyright guard (#1053). It runs only where the ROM is present; without it the gate says so and passes.
