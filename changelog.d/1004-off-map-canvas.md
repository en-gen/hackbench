### Changed

- A horizontal map in the map view now has a fixed gutter, half a screen (128 px) wide, on its left and right (#1004, owner ruling D48 part 2). The background colour is solid across the map and fades to transparent over each gutter. Sprites that the data places in the gutter (the ghost house door, for example) and refused-object marks ("!") in it are drawn there at their own position; grid lines continue across it and a thin line marks the map's edge. Vertical maps are unchanged, and nothing is added above or below a horizontal map yet.
