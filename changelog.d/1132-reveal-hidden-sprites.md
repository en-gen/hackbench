### Added

- Map view: a sprite that draws nothing until something happens (an invisible mushroom that waits for Mario, a mole, a block a switch turns on) is now drawn where it would appear, through the screen door, with a hover that says what shows it (#1132). The app finds the condition by rerunning the sprite's own code with Mario and the switches changed; no sprite ids are listed. A sprite no condition shows keeps its marker, with a new reason. `sprite:report -- --reveal --map <hex>` lists, per placed sprite, what drew at rest, what is hidden and what revealed it.
