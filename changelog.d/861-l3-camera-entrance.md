### Changed

- Maps (#861): the drawn Layer 2 height now uses the same entrance as the Layer 3 camera (`chooseEntrance`). On vanilla, 0 of 512 slots change (an uncommitted sweep, one machine); a map entered only through secondary entrances, listed out of order, now uses the lowest entrance id (synthetic tests only).
