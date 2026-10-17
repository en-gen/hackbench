### Changed

- Tests: a unit case now pins every opaque castle flame pixel to the CGRAM row its OAM attribute selects, on a synthetic cart with distinct colours per row, so a flame drawn from the wrong palette row fails (#965). Why: PR #964 left the flame colours unpinned against the palette. Evidence: planted row flip goes red (see PR); no production code changed.
