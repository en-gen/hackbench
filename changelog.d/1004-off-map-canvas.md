### Changed

- The map view's canvas now extends past the map for content the data places off it (#1004). A refused-object mark ("!") or a sprite whose position is outside the map draws there, at the position the data names, instead of being pulled onto the map's last row or column or cut off. The margin is whole tiles plus one tile, grid lines continue across it, and a thin line marks the map's edge; a map with nothing off the map looks exactly as before.
