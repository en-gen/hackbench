### Changed

- Map view: each sprite is drawn at the position in the map's sprite list, with the look its start-up code gives it (tiles, flips, variants), so the P-switch and the Pokey now show their pictures. The moves that start-up code makes are left for play/simulate, so nothing shifts. Chainsaws and grinders, which start-up code moves off the screen, are drawn too. Sprites that still cannot be drawn keep the not-drawn marker (#980).
