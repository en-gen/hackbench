### Added

- Map view (#981): hovering a placed sprite shows its name and id as a tooltip ("Podoboo (sprite $33)"), and clicking it puts the same in the status bar (a click on empty ground clears it). The topmost sprite at the pointer wins, by the order the sprites are drawn in; a sprite hidden by a tile shows too. Names come from the app's sprite name table.

### Fixed

- Sprite names (#981): `$33` is Podoboo (was "Fireball"), `$28` Big Boo (was "Blue Shell"), `$29` Koopa Kid (was "Spike Top (counter-clockwise)"). `$28` and `$29` follow the `SMWDisX` pointer-table comments (`bank_01.asm:271-272`). `$33` does not: that table's comment reads "33 - Fireball" (`bank_01.asm:282`, handler label `Fireballs` at `bank_01.asm:13041`), but the handler plays `!SFX_PODOBOO` (`bank_01.asm:13048`), so the name follows that sound evidence and the comment disagrees. The other renamed entries were not re-checked beyond these.
