# Rerun CI on a pull request

Use when a required check is cancelled or must be repeated. `[EST]` from PR #613, 2026-10-05, one repository.

1. CI uses workflow-level concurrency with `cancel-in-progress: true`, one group per PR ref. Rerunning only the failed jobs of an older run collides with the head commit's run, and a queued required job (the Theia type-check) is cancelled with zero steps, leaving the PR blocked.
2. A cancelled required check is not a success. On docs-only changes the job should be skipped, which happens only when the whole run on the head SHA re-evaluates the `changes` job.
3. So rerun the whole latest run on the head SHA. Never use `--failed`, and never rerun an older run.
4. Auto mode blocks `gh run rerun` from agents as a CI bypass. Hand the owner the exact command and wait; do not retry.
