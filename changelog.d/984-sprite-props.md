### Added

- Maps view (#984): clicking a sprite opens a read-only Properties panel on the right (View > Properties reopens it) with the sprite's id, name, position, each drawn part (tile, palette row, flips, offset), the palette rows used and a preview of the sprite. It says plainly that the sprite is not animated in this view: the map holds one pose per sprite, so there is no frame loop yet. Empty ground or closing the map shows "No sprite selected". Evidence: unit tests on synthetic sprites; the Playwright spec for a vanilla map was written but not run by the author.
