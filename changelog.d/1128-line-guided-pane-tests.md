### Changed

- Sprite Properties preview tests (#1128): a synthetic run where the sprite moves along a track keeps one anchor across frames (both draw baselines, several pass counts), and a Playwright spec checks the chainsaw's drawn left and bottom edges hold across frames on map $00F. Test and comment changes only: SpriteRunner and framesOf comments now name every line-guided id, not only $67, and the at-rest comment names D156; per-id ($65-$68) guards; one machine, no behavior change.
