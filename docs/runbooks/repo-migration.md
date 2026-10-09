# Repository migration of 2026-09-27

Use when an old issue, PR or commit number from before 2026-09-27 turns up. `[EST]` one repository.

1. The original repo became private `en-gen/hackbench-archive` (unfiltered history, all old PRs). A new public `en-gen/hackbench` holds filter-repo'd history. Reason: a public repo cannot hold ROM-derived bytes, and GitHub keeps PR refs forever (the owner declined a Support purge).
2. Every SHA changed; all commits were re-authored to the owner's personal address. There is no `main` until a release.
3. Remotes: `origin` is the new repo, `archive` the old. A pre-push hook blocks old history; never `--no-verify`.
4. Issues transferred with new numbers. Any number in older notes is an archive number. Map them with `issue-map.tsv` in the tools checkout (columns old_archive_issue, new_issue). `gh issue view <old> -R en-gen/hackbench-archive` does not follow transfers. Old PR numbers exist only in the archive.
5. Retarget a branch: fetch; if nothing is unpushed and the trees are equal, `git reset --hard origin/<branch>`; else `git rebase --onto origin/<branch> archive/<branch>` (or `origin/develop archive/develop`).
6. Content gate: `tools/scripts/check-content.mjs`, run on pre-commit, pre-push and CI including full history. A develop commit message that false-positives goes in `tools/scripts/content-gate-reviewed.txt` as `<sha> <rule> -- reason`. A CI re-run reuses the old merge commit; merge develop into the PR branch to pick up a fix.
7. Actions minutes: private repos (hackbench-validation) share about 2,000 minutes a month on the Free plan; e2e (about 35 minutes a run) is the big consumer (split proposed in hackbench-validation#23). Blocked runs show "recent account payments have failed"; 2-second red checks are billing, not code.
