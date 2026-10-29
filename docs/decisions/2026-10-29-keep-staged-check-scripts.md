Proposed 2026-10-29 (BA, #1183)

# Keep the staged-check scripts after the pre-commit hook is gone

## Question

The pre-commit hook was removed (PR #1186). Nothing calls `tools/scripts/check-staged-style.sh`, `tools/scripts/check-staged-content.sh`, or the test in `lintGate.test.ts` that proves the style script can fail. Do they stay or go?

## Options considered

1. Keep them as tooling for the refinement in #1163. `[PROP]`
2. Delete them now and restore them from history if #1163 needs them.

## Ruling

wording not recorded. The hook removal itself was ruled (R28, 2026-10-28): "let's remove the git hook altogether for now. we can refine this idea further, later". Keeping the scripts is not ruled; option 1 is taken as a proposal only. `[PROP]`

## Why

- #1163 will likely reuse the scripts. `[INF]` from the refinement being the stated next step of R28.
- Deleting and then restoring costs more than leaving them in place. `[INF]`
- `lintGate.test.ts` keeps proving the style script can go red, which the "oracles must be proven able to fail" rule requires of any check that stays.
- Evidence scope: the PR #1186 verification, one machine, Windows, 2026-10-28. It showed nothing calls the scripts; it did not test whether #1163 will reuse them. `[EST]`

## Applies to

`tools/scripts/check-staged-style.sh`, `tools/scripts/check-staged-content.sh`, `test/suite/gates/lintGate.test.ts`, and the design of #1163.
