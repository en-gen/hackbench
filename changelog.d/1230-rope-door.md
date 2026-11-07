### Changed

- Map view (#1230, D152, Decision 103 E): on a sprite memory setting where the rope is long only if a high sprite slot is free at spawn (2 to 10 and 12 to 16), the rope now draws its extra length in the screen door: the first 5 tiles are solid and the extra 4 are see-through, hover lifts them separately, and the tile under a dim pixel keeps its color math. This replaces the short-only rope of the previous change for those settings. Vanilla ROM, map $00F with its setting edited to 2 to 7, one machine: the rope at column 205 is 9 tiles with the extra length in the door.
