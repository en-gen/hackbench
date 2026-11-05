### Changed

- The map view's gutter is now one screen (256 px) wide and sits at the far end of a map only (#1228, owner ruling D172, replacing the left half of D48 part 2 and R24). A horizontal map has no gutter on its left and a vertical map none on top, since adding there would move position (0,0). The back color fades out over the far-end gutter only, the checkerboard reaches the near edge, and a map of 32 screens, which cannot grow, has no gutter. Content the data places before the map still draws there, as a solid band.
