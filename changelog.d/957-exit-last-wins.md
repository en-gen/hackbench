### Fixed

- Exit graph (#957): when two screen exit objects in a map name the same screen, only the last one counts, as the game stores one screen exit per screen (SMWDisX `bank_0D.asm:1428-1435`). Evidence: synthetic ROMs plus a sweep of all 512 vanilla slots (227 screen exit objects, none sharing a screen, so no vanilla edge changes), one ROM revision, one machine. A parse survey found same-screen pairs in all four corpus hacks (GPW2 1.1: 48 slots, GPW 1.2: 17, Invictus 1.0: 68, Seven_Vanilla_Levels: 6), and all four refuse the exit graph, so nothing they show changes.
- Exit graph (#957): the screen-exit handler is run on the 65816 core before the rule is applied (no byte pattern); a ROM whose handler files exits differently gets no exit graph, with the reason named.
