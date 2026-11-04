### Fixed

- The Layer 3 range indicator no longer says a tide scrolls 1:1 with the camera (#808). The game steps a tide's horizontal position one pixel per frame plus the camera's movement, always in the $100-$1FF range, and the indicator now says so. Layer 3 settings bytes $02-$7F (such as the Yoshi's Island 4 water) are now labeled tides too; their vertical position stays still. The tide's drawn horizontal position is unchanged (X 0): the 271 seen on two tide maps in the captures is leftover phase from a long entrance wait, not a load value.
