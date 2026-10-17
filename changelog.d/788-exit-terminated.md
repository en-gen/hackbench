### Fixed

- Maps view (#788): the screen exit graph no longer counts exits read from a layer 1 stream that never reaches `$FF`, the same rule the start lookup uses (#787), now one shared helper. Evidence: synthetic unit test plus a sweep of 6 corpus ROMs, one machine; vanilla and its Lunar Magic re-save have no unterminated stream (0 change), 2 hack ROMs do (5 and 2 slots).
