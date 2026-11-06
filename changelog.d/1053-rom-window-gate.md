### Changed

- The content gate now blocks an added code or data file whose byte lists (hex arrays, `$` lists, `\x` strings, hex strings, also inside comments in the common cases) match 8 bytes of the vanilla ROM (#1053). It judges files a commit adds (in range and push a merge of develop no longer counts develop's files; staged does not apply the merge rule), runs only where a usable ROM is present, and says when it did not run (no usable ROM, or history mode). CI has no ROM and keeps its other checks. Masked arrays are not seen yet (#1280).
