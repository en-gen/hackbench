# Know when a pull request merged

Use when an agent must act after a merge (cleanup, the next item). `[EST]` from #659, #667 and the rate-limit event of 2026-10-06, one repository.

1. The desktop app's auto-fix monitor wakes a session on CI failures, merge conflicts and review comments, but not on the merge itself. Do not wait for an event.
2. Dispatch one Sonnet grunt per PR when auto-merge is armed, with a bounded wait: poll every 90 seconds, at most 40 times. #667 merged after 6 iterations.
3. Poll with REST, not `gh pr view`: `gh api repos/en-gen/hackbench/pulls/<n>` (state, merged, merge_commit_sha, mergeable_state, auto_merge), plus `commits/<sha>/check-runs` for failures. Several parallel `gh pr view` loops tripped GitHub's secondary GraphQL limit while the hourly quota showed 4,997 remaining, and blocked thread resolves and board reads for about 30 minutes.
4. Keep GraphQL for one-off reads. Retry a failed review-thread resolve on a later poll only when `gh api rate_limit --jq .resources.graphql.remaining` is above 100; CodeRabbit usually resolves its own thread once it confirms a fix.
5. On merge, the grunt runs cleanup: remove the junctions in `theia/node_modules` first with `rmdir` (a verifier leaves junctions into the worktree), then `git worktree remove`, delete the branch, check the board, `git pull --ff-only` on develop, `npm run gitnexus`.
6. The tech lead itself never polls CI. The grunt reports the wait length and the merge state.
