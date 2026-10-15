### Changed

- The data banks record from #755: a `meta/data-banks.json` made for a different
  base ROM (its `rom` SHA-256 does not match this project's base ROM) is
  ignored, and detection runs again for this ROM and rewrites the file. The
  SHA-256 is compared before the file's shape is checked, so a malformed file
  made for another ROM is replaced rather than refused. A file with no readable
  `rom` string is still shape-checked and refused. Evidence:
  `src/project/DataBanksConfig.ts:51` (#889).
