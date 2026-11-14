Proposed 2026-11-14 (delta, #1333, PR #1410; night-shift [PROP], approved by Overwatch 2026-11-14, awaiting owner)

# The four per-test timeouts under 30 s are all raised to 30 s, none kept

## Question

#1333 lists four per-test timeouts under 30 s in process-starting test files: `contentGate.test.ts` line 79 (`slow(11000)`) and line 344 (`slow(15000)`), and `playwrightAppDataGate.test.ts` line 265 (`slow(12_000)`) and line 278 (`slow(10000)`). A per-test value replaces the file's 30 s budget, so each undercuts it. Each could be raised, or kept with a `// timeout-floor: <reason>` comment the gate reads. Which?

## Options considered

1. Raise all four to `slow(30_000)`.
2. Keep some, each with a `// timeout-floor:` reason.

## Ruling

wording not recorded. 2026-11-14, night shift: option 1, all four raised to `slow(30_000)`, none kept. `[PROP]`

## Why

- Bravo measured a margin of 3x or better on each of the four under load (#1333; one machine, not re-run here). Raising them costs only a slower failure on a real hang.
- A kept value is a second rule to maintain: a marker, a reason that can go stale, and a gate branch that has to keep reading it.
- The marker stays available for a later value that truly needs a short timeout; none on the tree does today.

## Applies to

`test/suite/gates/contentGate.test.ts`, `test/suite/gates/playwrightAppDataGate.test.ts`, `test/suite/gates/perTestTimeoutFloor.ts`, `docs/testing.md` (the #1333 paragraph).
