Ruled 2026-10-04 (Brian)

## Question

Where do CI and nightly runs that need the ROM execute?

## Options considered

GitHub-hosted runners with the ROM as a secret; a self-hosted runner on the owner's hardware.

## Ruling

Owner policy 2026-10-04, wording not recorded. ROM-needing runs (e2e, captures, perf nightlies in hackbench-validation) execute on the owner's hardware via a self-hosted runner, pve01 (Proxmox) the intended host. ROM-free CI stays on GitHub-hosted runners in the public repo. `[EST]`

## Why

- The owner prefers the copyrighted ROM off cloud machines. `[EST]`
- It removes private Actions minute limits (Sep 2026 overran the 2,000-minute free allowance). `[EST]`

## Applies to

- Never load the ROM onto GitHub-hosted runners, or move ROM workflows to the public repo with a secret.
- New ROM-needing workflows target the self-hosted runner label; register the runner to private repos only.
- #415 (perf nightly) waits for the runner.
- Since 2026-10-06 the e2e workflow has no automatic triggers. Until #536 is live, agents never start `e2e-playwright.yml` or hackbench's `e2e-dispatch.yml`; only the owner may, deliberately. `[EST]`
