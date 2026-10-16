### Changed

- A `meta/data-banks.json` whose `rom` is a string other than the project's
  base ROM SHA-256 is set aside unchecked: detection runs for this ROM and the
  file is rewritten if the write succeeds (`src/project/DataBanksConfig.ts:51-52`,
  `:66-74`). A file that is not valid JSON, or whose `rom` is not a string, is
  still refused with no detection (`:47`, `:53-59`, `:79-80`) (#889).
