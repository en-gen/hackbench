### Added

- The map view marks each Layer 1 object the drawer refused (an object type HackBench cannot draw yet, or whose drawing code could not be read safely) with a red dashed cell marked "!" at the object's anchor tile, and a tooltip saying why in plain words (#816). Only the anchor is marked, since a refused object's footprint is unknown. Vanilla refuses none: 488 readable slots swept, 0 refusals (one machine, vanilla ROM).
