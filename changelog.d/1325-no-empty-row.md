### Changed

- The map view no longer adds an empty row (or column) for a sprite whose art spills past the map's edge (#1325, owner ruling 2026-11-07). Maps $00E, $01B, $0F8 and $110 lost the 16 px row below the map; $0D7 lost 8 px above, and nine maps lost the 8 px column on the left. The art is cut at the map's edge and the sprite still hovers and selects from the part on the map. A sprite or refused-object mark placed off the map still grows the canvas and shows there, and the far-end gutter is unchanged.
