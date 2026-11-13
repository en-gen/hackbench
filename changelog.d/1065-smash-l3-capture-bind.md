### Changed

- Tests and docs: the smash-driven Layer 3 on maps $01F and $1D4 is bound to the Mesen captures (#1065): the map view's Y equals the capture's Layer3YPos at frame 0, its X equals frame 8's BG3HOFS (the first landing, #997), and its BG3 tilemap equals frame 0's; evidence: 2 maps, vanilla, one machine. A synthetic case checks Y comes from the landing, not $D0, through the real smash reader. docs/rom/level-rendering.md now lists $011, $130 and $1C1 as drawn (25 of 512 slots, $018 refused; #1051).
