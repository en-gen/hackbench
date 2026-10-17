### Fixed

- Maps view (#997): on the maps where a smasher moves Layer 3 (`$01F`, `$1D4`, `$1FC`), Layer 3 is now drawn once, where the game first shows it, instead of repeating every 512 pixels across the map. The game moves it with the camera; the view shows one copy at the low end of where it starts each cycle. The Layer 3 button's tooltip says that it follows the camera in the game.
