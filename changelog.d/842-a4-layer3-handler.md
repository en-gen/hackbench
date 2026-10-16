### Fixed

- Map sprites: the floating spike ball (sprite $A4) on tide levels no longer sinks 32 px below its placed position; the sprite runner's level loader now runs the game's Layer 3 handler, so sprites in a tide level read the tide as liquid (#842). Evidence: 9 of 9 records on map $102 now end at their list position, grader exact 998 to 1022 of 1957 (one machine, vanilla ROM, the capture set); 5 dolphins on map $002 grade shape instead of exact, see docs/sprites/sprite-a4-floating-spike-ball.md.
