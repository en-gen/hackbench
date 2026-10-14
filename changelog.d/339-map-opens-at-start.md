### Changed

- Maps view (#339): a map now opens scrolled to where the player first enters it (vertical maps scroll down to it), read from the entrance tables; when the ROM's entrance loader is not the stock one, it stays at screen 0 and says the start is unavailable. Evidence: unit tests on synthetic ROMs plus vanilla `$109` (screen 6) and `$1C1` (screen 3), one ROM revision, one machine; hacks not surveyed. A screen exit read from a stream that never reaches `$FF` is ignored, and such a stream also stops counting as a stepping stone to other maps.
