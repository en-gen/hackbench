### Changed

- The data banks record from #755: a `meta/data-banks.json` made for a different
  base ROM (its `rom` SHA-256 does not match this project's base ROM) is
  ignored, and detection runs again for this ROM and attempts to rewrite the
  file. The SHA-256 is compared before the file's shape is checked, so a
  malformed file made for another ROM is replaced rather than refused. A
  read-only project folder keeps the old file and detection reruns on each open
  (the failed write is caught). A file with no readable `rom` string is still
  shape-checked and refused. Evidence: `src/project/DataBanksConfig.ts:51`
  (comparison), `:69-76` (write and catch). Detection runs on every `get` in
  `src/project/WorkingRomRegistry.ts:281-285` (cached path) and `:318` (first
  build) (#889).
