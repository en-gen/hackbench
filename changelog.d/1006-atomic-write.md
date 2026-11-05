### Changed

- One atomic file writer (#1006): `src/project/atomicWrite.ts` replaces the separate temp-then-rename writers in SaveStore, ProjectMeta, ExportPatch and two tools scripts; every one now writes a pid-named temp file, flushes it, renames with the Windows retry, and removes the temp on failure. Unit tests on temp directories, one machine; no behaviour change intended.
