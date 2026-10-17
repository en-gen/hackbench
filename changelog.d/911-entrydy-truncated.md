### Fixed

- Maps view (#911): a ROM that ends before the entrance tables no longer draws layer 2 at a made-up height of 0; the layer says "The ROM ends before the entrance tables that place it". Evidence: synthetic-ROM unit tests (each table byte unreadable in turn, plus a sweep over 5,244 cut points with entrances and about 3,000 without the exit graph); a planted `?? 0` fails the byte and sweep tests; no corpus used.
