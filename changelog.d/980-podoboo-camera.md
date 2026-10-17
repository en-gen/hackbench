### Fixed

- Map view (#980): a sprite whose INIT moves it off the screen centred on its list position is re-run once with the camera on where INIT left it, so the seven Podoboos ($33) on map `$11C` (and 42 more across vanilla maps) are drawn full height on the lava instead of an 8 px strip. The same re-run lets 7 chainsaws ($65, map `$0F`) and 3 grinders ($67, map `$1A`), line-guided sprites that used to draw nothing, appear. Evidence: before/after diff of every sprite box on maps `$000`-`$1FF`, vanilla ROM, one machine; 3387 sprites, 59 changed, none other.
