### Changed

- Tests only (follow-up to #787): the Maps start-position test that withholds every entrance-table byte in turn (32 bytes, same sweep and same refusal asserted) now builds one ROM and derives the overworld once, with a check that the shared derivation never reads a withheld byte. It took about 34 s or more under the coverage run (61 s on CI, past the 60 s limit) and now takes about 1 s. Evidence: one machine, vitest 5.0.3 with v8 coverage.
