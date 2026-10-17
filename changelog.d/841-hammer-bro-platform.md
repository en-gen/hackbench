### Fixed

- Maps view: sprite $9C, the flying Hammer Bro platform, now draws the Hammer Bro it carries. Its own code scans the slots for a $9B, so a sprite that does so is run a second time with the level's neighbouring sprites in the other slots, and the second run is used when it only adds parts (#841). Vanilla ROM, one machine: the 14 $9C records in the sprite grader leave "wrong" (wrong 125 to 111 with exact 998 to 1003, shape 803 to 812, no record worse).
