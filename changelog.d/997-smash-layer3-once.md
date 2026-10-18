### Fixed

- Maps view (#997): on the maps where a smasher moves Layer 3 (`$01F`, `$1D4`, `$1FC`), Layer 3 is now drawn once, where the game first puts it, instead of repeating every 512 pixels across the map. The position is worked out by running the game's own code from power-on, not stored. The game moves it with the camera; the Layer 3 button's tooltip says so. If the game's code cannot be run for a map, Layer 3 stays where it loads and the map note says its position is unverified, with the reason.
