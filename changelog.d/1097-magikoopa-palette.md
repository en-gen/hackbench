### Fixed

- Map view: the Magikoopa on map $11C is drawn in blue, not pink (#1097). The view used the colors written by the first frame it drew, the fade-in, which runs before the game's first palette upload; it now uses the last rung the cart's own code leaves in sprite row 15 (columns 0-7), the other columns keeping the level's colors. Evidence: 0 of 387 opaque pixels differ from the hardware capture's row 15 (262 did before), vanilla ROM, one machine; $11C is the only vanilla map where a Magikoopa is drawn ($1FE draws no tile at rest).
