### Fixed

- Map view: a sprite whose code draws first and moves itself afterwards in the same frame (the Super Koopa, the Blurp, the goal tape and about twenty more) is drawn on its placed spot at rest. Before, the picture sat off it by the sprite's own move: mostly 1 or 2 px, up to 6 px ($6E on map $24). Evidence: 441 of 3239 sprite rows change, over the 512 vanilla level numbers, one machine; every shift equals the sprite's move. A draw that displaces the sprite and restores it (the Koopas) is unchanged.
