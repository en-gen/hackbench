### Fixed

- Maps view: a pipe whose variant table entry points at code the port does not know is now reported as refused, with the object, the variant and the address, instead of drawing nothing and saying nothing (#1033). Why: the lookup used `?.` and skipped a missing handler silently, against D52 (never hide a placed object) and D57 (interpret or warn); evidence: synthetic cart tests (no ROM) sweeping 0x0DAB40-0x0DB000 in steps of 0x11 for the unknown targets and the 10 known ones for the unchanged case, one machine.
