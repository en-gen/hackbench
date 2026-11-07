### Changed

- Sprite Properties preview tests (#1128): a synthetic run where the sprite moves along a track keeps one anchor across frames (both draw baselines, several pass counts), and a Playwright spec checks the chainsaw's drawn left and bottom edges hold across frames on map $00F. Tests only; one machine, no behaviour change.
