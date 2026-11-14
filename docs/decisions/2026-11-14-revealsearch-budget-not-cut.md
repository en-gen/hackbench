Proposed 2026-11-14 (delta, #1332, PR #1410; night-shift [PROP], approved by Overwatch 2026-11-14, awaiting owner)

# The 32 px window test gets a 60 s budget and keeps all its work

## Question

#1332 acceptance 2 allows either a `loadTimeout` budget for "leaves no 32 px window of the low byte unprobed, wherever the window starts" (`RevealSearch.test.ts`), or cutting its work so it runs under 25% of its budget alone. Which?

## Options considered

1. A budget: `slow(60_000)`, work unchanged.
2. Cut the work below 25% of the budget alone. This needs a proof that the reduced sweep still catches a planted gap (acceptance 3).

## Ruling

wording not recorded. 2026-11-14, night shift: option 1, `slow(60_000)`; the work is not cut. `[PROP]`

## Why

- The test sweeps all 256 window starts of the low byte. A smaller sweep is a weaker claim and would need its own planted-gap test; a budget is one line.
- Measured alone: 2.3 to 3.1 s (7 runs, one machine). Under the #485 load: 7.3 to 10.0 s (#1332, one machine). 60 s is about 6x the loaded worst.
- A planted 70 s hang still fails at 60 s, so the budget does not hide a stuck test (by vitest's timeout rule; not run here).
- Cost: the old 5 s default no longer acts as a performance canary for this loop; a slowdown shows only as a longer run, not a failure, until it passes 60 s.

## Applies to

`test/suite/unit/sprites/RevealSearch.test.ts`.
