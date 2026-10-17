### Fixed

- Maps view (#911): a ROM that ends before the entrance tables no longer draws layer 2 at a made-up height of 0; the layer says "The ROM ends before the entrance tables that place it". Evidence: synthetic-ROM unit tests (each table byte unreadable in turn, plus a sweep over 5,244 cut points with entrances (5,236 refused, 8 drawn) and 3,262 without the exit graph, 3,254 refused and 8 drawn); a planted `?? 0` fails the byte and sweep tests; no corpus used.
