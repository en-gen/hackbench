### Changed

- Tests (#1233): the off-map canvas spec's bottom-band cases rest on map $110 (a Ball 'n Chain 16 px below the map) instead of $102, whose 24 px of sprites below the map came from the old 64-pass run and went away when sprites began to draw at their placed spot (#1119). A synthetic box 24 px below the map keeps the 24-rounds-up-to-32 case. Spec only; vanilla ROM, one machine.
