### Changed

- Map view: the L2 kind (image or object stream) now comes from the game's own per-level-mode uploader table, read by its bytes, not from the L2 pointer's bank. A map whose pointer disagrees with its mode, or whose mode uploads no L2, is refused with a reason; on vanilla and magic, one sweep of maps 0-$1FF, one machine, no map changed (#506). Targets are recognized by their opening bytes only.
