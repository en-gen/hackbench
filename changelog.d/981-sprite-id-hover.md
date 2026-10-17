### Added

- Map view (#981): hovering a placed sprite shows its name and id as a tooltip ("Podoboo (sprite $33)"), and clicking it puts the same in the status bar (a click on empty ground clears it). The topmost sprite at the pointer wins, by the order the sprites are drawn in; a sprite hidden by a tile shows too. Names come from the app's sprite name table.

### Fixed

- Sprite names (#981): `$33` is Podoboo (was "Fireball"), `$28` Big Boo (was "Blue Shell"), `$29` Koopa Kid (was "Spike Top (counter-clockwise)"). Checked against the `SMWDisX` pointer-table comments (`bank_01.asm:271-272`) and the `$33` handler (`bank_01.asm:13041-13051`, `!SFX_PODOBOO`); the other entries name the same sprite as those comments (compared by eye, one pass; wording differs).
