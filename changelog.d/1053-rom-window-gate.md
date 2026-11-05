### Changed

- The content gate now blocks an added code or data file whose byte lists (hex arrays, `$` lists, `\x` strings, hex strings) match 8 bytes of the vanilla ROM (#1053). It judges only files added in the net diff (a merge of develop no longer counts develop's files), runs only where the ROM is present, and says on every run when it did not run. CI has no ROM and keeps its other checks.
