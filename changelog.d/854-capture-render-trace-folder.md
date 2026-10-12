### Fixed

- capture_render no longer calls a finished sprite-trace folder aborted: a folder with calls.json and frames.json but no capture_summary.json is named a sprite-trace folder, and a layers folder without the summary is still reported incomplete (#854). Evidence: synthetic folders, no ROM.
