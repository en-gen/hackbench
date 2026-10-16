### Changed

- A `meta/data-banks.json` whose `rom` is a string other than the project's
  base ROM SHA-256 is ignored, with no shape check: detection runs for this ROM
  and the file is rewritten if the write succeeds
  (`src/project/DataBanksConfig.ts:51-52`, `:66-74`). A file that is not valid
  JSON, or whose `rom` is not a string, is still reported as not found, with no
  detection (`:47`, `:53-59`, `:79-80`) (#889).
