### Fixed

- Map view: map $018 (level mode 0E) now draws its camera-locked layer 3, added onto layers 1 and 2 like the other `$81` maps, and the 40 layer 3 cells it lost are back (#805). The stripe-image loader dropped the last word of every run-length run with an odd byte count; the same fix restores 2 cells on each of the tide maps $002, $0BE, $0C1, $102 and $127. Evidence: tilemap equals the `layers_v5` capture's on all 3584 cells below the status bar for $011, $130, $1C1 and $018, vanilla ROM, one machine.
