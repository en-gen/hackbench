### Changed

- Map view: a sub area's drawn layer 2 height and layer 3 camera now use the entrance first reached on the normal route from the level's overworld entrance, not the lowest secondary entrance id, and a map no route reaches says so in its details (#945, D66 call 1). Evidence: synthetic ROM cases and a 512-slot sweep of the vanilla ROM on one machine, where 0 slots change their entrance and 301 slots show the new note; no emulator capture.
