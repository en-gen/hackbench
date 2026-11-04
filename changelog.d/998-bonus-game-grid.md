### Fixed

- Map view (#998): the bonus game sprite on maps 000 and 100 now shows its 3 x 3 grid of nine blocks where the game puts them, instead of a grey marker. The game ignores where the sprite sits in the list, so the grid does not move with the sprite or a drag (D158). Evidence: the picture is the game's own setup code run on HackBench's ROM-run level loader image, vanilla ROM, one machine, emulated CPU; no hardware capture exists for these maps.
