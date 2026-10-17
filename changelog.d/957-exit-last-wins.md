### Fixed

- Exit graph (#957): when two exit objects in a map name the same screen, only the last one counts, as the game stores one exit per screen (SMWDisX `bank_0D.asm:1428-1435`). Evidence: synthetic ROMs plus a sweep of all 512 vanilla slots (227 exit objects, none sharing a screen, so no vanilla edge changes), one ROM revision, one machine; hacks not surveyed.
