### Fixed

- Map view: a sprite that looks for a companion among its neighbors no longer takes graphics uploads from a neighbor when it is drawn alone (#1169). Each of its two runs now keeps its own record, and only the run the picture comes from supplies the uploads. In a sweep of 488 of 512 vanilla maps (24 skipped by the loader on both sides, one machine, one run), 13 sprites on 3 maps had their upload records shortened or trimmed (ids $1E and $1F), and what is drawn on those maps hashed identical.
