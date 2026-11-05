### Changed

- Tests: a unit case now pins every opaque castle flame pixel to the CGRAM row its OAM attribute selects, so a flame drawn from the wrong palette row fails (#965). Why: PR #964 left the flame colours unpinned against the palette. Evidence: synthetic cart, no ROM; all eight palette values swept with literal rows 8-15, colour 0 excluded, alpha compared, exactly 16 x 16 opaque pixels per flame; planted mutants (row flipped with ^1, row forced odd with |1, opaque black colour, only part 0 blitted) each turn it red, one machine; no production code changed.
