### Changed

- Corpus checks leave out personal ROMs (#1289): a `personal.txt` in the ROM folder, outside git, lists carts kept there that are not corpus; `romsOnDisk()` skips them and the membership guards still fail on any other unknown cart. Synthetic scratch-folder tests, one machine; no ROM content.
