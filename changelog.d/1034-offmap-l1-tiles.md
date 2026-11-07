### Fixed

- Map view (#1034, D76 call 2, D52): a Layer 1 object whose tiles run past the map's bottom row or last column is drawn where the game's buffer puts them, not dropped. A row past the bottom is the next screen's top rows, so map $021 gains seven tiles on screen 9 (its Mesen capture had them; it now matches); cells past the last screen draw in the off-map band. A tile outside the buffer entirely marks its object with a "!" and a plain reason. Vanilla ROM, one machine: maps $000, $021, $100 and $108 change. A vertical map's column wrap is not modelled.
