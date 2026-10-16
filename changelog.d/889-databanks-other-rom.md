### Changed

- A `meta/data-banks.json` whose readable `rom` SHA-256 differs from the
  project's base ROM is now ignored, whatever else is in it: detection runs for
  this ROM and the file is rewritten if the write succeeds
  (`src/project/DataBanksConfig.ts:51-52`, `:66-74`). A file with no readable
  `rom` string is not ignored: it fails the shape check and is refused with no
  detection (`:53-59`, `:79-80`) (#889).
