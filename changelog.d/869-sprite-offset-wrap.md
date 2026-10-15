### Changed

- Sprite grader: re-based piece offsets now wrap as the hardware does (9-bit X, 8-bit Y), so a piece the capture records at X -240 is no longer graded +272 and Magikoopa $1F on map $11C slot 8 grades exact; evidence: vanilla ROM, layers_v5 captures, one machine (#869).
