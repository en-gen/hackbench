### Fixed

- Map view (#1319): a whole-door sprite (#1132) drawn past the map edge no longer reads as solid there. Its off-map pixels in the canvas pad keep the screen door's checkerboard — the same squares the screens dim inside the map — so one sprite no longer looks hidden on one side of the edge and plain on the other. The rope's door parts already drew that way (#1316); whole-door sprites now get the same treatment.
