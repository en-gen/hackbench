### Fixed

- Maps view: sprite $9C, the flying Hammer Bro platform, now draws the Hammer Bro it carries. Its own code scans the slots for a $9B, so a sprite that does so is run a second time with the level's neighbouring sprites in the other slots, and the second run is used when it only adds parts (#841). Vanilla ROM, one machine: the 14 $9C records in the sprite grader leave "wrong" (wrong 90 to 76 with exact 1033 to 1038, shape 803 to 812, measured on top of #837, no record worse).
