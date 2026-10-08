Ruled 2026-10-04 (Brian)

## Question

Does the adversarial review change, given its cost?

## Options considered

Drop or shrink the review; keep it unchanged and track it.

## Ruling

Owner decision 2026-10-04, wording not recorded. Keep the review unchanged, but track it. `[INF]`

## Why

- Evidence prompting the question: four rounds on #524, about 200k tokens and 20-100 minutes each, only round 1 found vanilla-visible defects. `[EST]`
- The owner wants evidence before changing the process. `[EST]`

## Applies to

- After every review run (adversarial, simplify, verifier, CodeRabbit, owner UAT) append a row to the review ledger in the owner's notes repository: tokens, minutes, findings classed V/H/T/N, CodeRabbit overlap.
- Re-evaluate on 2026-11-01 or after 15 rows.
- Launch the app for the owner as soon as a UI branch builds, so owner testing runs alongside the adversarial review.
