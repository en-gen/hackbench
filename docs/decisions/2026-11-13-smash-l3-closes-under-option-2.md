Proposed 2026-11-13 (papa, #1065; night-shift [PROP], accepted by Overwatch)

# #1065 closes under option 2: the map view takes the smasher's first-frame write

## Question

The issue (#1065) asks that the smash sprite's first-frame Layer 3 write (CODE_00FF61: Layer3YPos = $A0 minus the sprite's Y, plus the shake) be visible, and allows two ways: option 1, run the sprite frames inside the level loader (`loadLevelState`), or option 2, the map view's Layer 3 position takes the write into account. Which one closes it?

## Options considered

1. Sprite frames inside the level loader, so `loadLevelState` ends prep at the written Y.
2. The map view takes the write: `buildL3Verdict` uses the smasher's first landing (`readL3SmashLoadPos`, `firstLanding`), as PR #1060 (#997) already does.

## Ruling

wording not recorded. 2026-11-13: option 2 is taken, and #1065 closes on it. `[PROP]`

## Why

- Option 2 is in place since PR #1060 (#997, merged 2026-10-18). Evidence scope: SMWDisX read plus `L3Smash.test.ts` and `MapScreenL3.test.ts` (synthetic), and a corpus test binding maps $01F and $1D4 to their `layers_v5` captures (vanilla, one machine; both maps share one landing, so one data point).
- `loadLevelState` keeps $D0 at the end of prep by design. Nothing reads the loader's Layer3YPos on these maps but the smasher, which overwrites it on its first pass, so option 1 would change a value no reader sees.
- The frame-0 capture shows Y $A0 on both maps, equal to the landing Y (placed and landing Y are both 0), so the map view's Y matches the hardware.

## Applies to

`src/rom/model/L3Model.ts`, `src/rom/L3Smash.ts`, `docs/rom/map-data-mechanics.md` ("Layer 3 under a smash sprite"), `test/suite/unit/L3SmashCapture.corpus.test.ts`.
