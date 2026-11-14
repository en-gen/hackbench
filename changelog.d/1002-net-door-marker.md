### Fixed

- Climbing net door on map $101 (#1002): pinned to what the game does. It draws nothing at rest (a punch arms the timer that draws it), so each door shows the quiet ring at its placed spot, never the failure box, and never over the castle flames; covered by a synthetic test, a vanilla-ROM test and a map $101 pixel spec. No drawing change was needed.
