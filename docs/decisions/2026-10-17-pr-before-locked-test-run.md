Proposed 2026-10-17 (Whiskey)

# Open the PR before the locked test run when the lock queue is long

## Question

When the run lock queue for the full `npm run test:unit` is very long, does a PR wait for the locked run before it opens?

## Options considered

1. Wait for the lock, run the full suite, then open the PR.
2. Open the PR ready before the locked run, with every lock-free check passed, and arm auto-merge only after the locked run passes.

## Ruling

Option 2 `[PROP]`, a tech-lead call by Whiskey on #912 and #965 (PRs #1024, #1025). The queue was over 12 hours. Wording not recorded. Not ruled by the owner.

## Why

- CodeRabbit and CI run during the wait instead of after it `[EST]`.
- Nothing can merge before the full suite passes, because auto-merge stays off until the locked run passes `[EST]`.
- Outcome, one case: the locked run passed 2026-10-17 and both PRs merged 2026-10-18 `[EST]`.
- The auto-merge classifier refused arming with no review yet. engenb armed it 2026-10-18 01:30Z, after review `[EST]`. Arming waits for the locked run and for a review.

## Applies to

Tech leads and stewards when the run lock queue is long. Conflicts with the "PR after verify" order in `docs/agents/tech-lead-reference.md` only if that file is read as forbidding an open PR before the locked run `[OPEN]`: the owner would say.
