### Fixed

- Maps view (#911): a ROM that ends before the entrance tables no longer draws layer 2 at a made-up height of 0; the layer says "The ROM ends before the entrance tables that place the background, so layer 2 is not drawn". Evidence: synthetic-ROM unit tests (each table byte unreadable in turn, plus a sweep over about 1,700 cut points); a planted `?? 0` fails 10 of 12; no corpus used.
