Proposed 2026-11-07 (bravo, #1209)

# Two listed files needed budgets above the 30 s file budget

## Question

The loaded run for #1209 (head 88c9c32d) showed two listed files over the 30 s file budget. What do we do about them?

## Options considered

1. (A) Raise their budgets and rerun at the recipe load.
2. (B) Raise their budgets and accept the heavy run as it is.
3. (C) Hold the budgets and rerun unchanged.

## Ruling

wording not recorded. Option A was taken as [PROP] by Overwatch under night shift, 2026-11-07, and is not ruled.

Two RevealSweep tests get `slow(90_000)`; the `playwrightPortGate` describe gets `loadTimeout(120_000)` in place of 60000.

## Why

Evidence, one machine, head 88c9c32d: the two RevealSweep tests ("refuses a report path inside the repository" and "control: a path outside the repository gets past the guard") took up to 73.9 s at 2.7 times the recipe load, against the 30 s file budget; `playwrightPortGate` took up to 76.4 s against its 60 s. Wall time was 1274 to 1330 s against the spike's 478 to 483 s, CPU at 100 percent. The load is heavier than the spike's, so the numbers may overstate a normal busy machine.

Calibration (night-shift [PROP], Overwatch, 2026-11-07): the 33-process burner put full-suite walls at 911 to 935 s, so Overwatch set a counting band of 408 to 552 s (its rule, not the acceptance text) and stepped the burner down; 16 processes gave 333 to 338 s and 20 processes gave 407 to 410 s, so no run met the band, and the runs are shown side by side in PR #1330 for the verifier to grade.

## Applies to

`test/suite/unit/RevealSweep.test.ts`, `test/suite/gates/playwrightPortGate.test.ts`.
