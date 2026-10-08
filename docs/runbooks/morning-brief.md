# Morning brief

Run by the BA, through a grunt, when `day-shift` returns after a night shift. Mechanical: nobody reads the whole tree.

1. Proposed decisions: `grep -l '^Proposed' docs/decisions/*.md`. Each file is one decision for the owner.
2. Protocol log: read `.claude/state/protocols.log` in the main checkout from the night-shift activation line onward.
3. Merged PRs since that timestamp: `gh pr list -R en-gen/hackbench --state merged --search "merged:>=<ISO timestamp>" --json number,title,mergedAt`.
4. Open needs-owner PRs: `gh pr list -R en-gen/hackbench --state open --label needs-owner --json number,title,url`.
5. Stopped items: every team state file under `.claude/state/teams/` whose Phase line says stopped, with its reason.
6. Present to the owner one decision per message, in the decision-brief format in `docs/agents/decision-briefs.md`, numbered "Decision 1 of N". After the decisions, one message listing merged PRs, open needs-owner PRs with their launched build URLs, and stopped items.
7. For each ruling the owner gives, edit the decision file's first line to `Ruled YYYY-MM-DD (Brian)` and paste the ruling verbatim under Ruling.
