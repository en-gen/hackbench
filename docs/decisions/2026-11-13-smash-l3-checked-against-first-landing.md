Proposed 2026-11-13 (papa, #1065; night-shift [PROP], accepted by Overwatch)

# Smash-map Layer 3 is checked against its first landing, not the frame-0 placed X

## Question

On maps $01F and $1D4 the capture's frame 0 shows Layer3XPos as the PLACED sprite X pinned by CODE_00FF61 ($100 on $01F, where the placed X is $120; $70 on $1D4), while the map view draws X -104, the smasher's first landing (#997's design). Which X does the capture test bind the map view to?

## Options considered

A. The first landing: bind to the smasher slot's X in frame 0 WRAM (state 0 has run, C2 = 1, $1540 = $80) and to frame 8's BG3HOFS (920, -104 as a 10-bit signed value). Y is bound to frame 0's $24 once the slot's landing Y equals the placed Y (both 0).
B. The frame-0 placed X: change the map view to draw $100 or $70, which deviates from #997's approved design and is out of #1065's scope.

## Ruling

wording not recorded. 2026-11-13: option A, from the coordinator's ruling on this item. `[PROP]`

## Why

- #997 approved drawing the first landing; the placed X is a one-frame value before state 0 runs, and X then follows the camera.
- The capture itself shows both: frame 0 $22 is $100 / $70, the smasher slot in the same frame already holds X $FF98, and frame 8 reads -104.
- Evidence scope: two captures (`layers_v5`, vanilla, one machine) that share landing -104, Y $A0 and the same tilemap, so one data point. $1FC has no capture.

## Applies to

`test/suite/unit/L3SmashCapture.corpus.test.ts`, `docs/rom/map-data-mechanics.md` ("Layer 3 under a smash sprite").
